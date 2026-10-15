import { initializeJournal } from './journal-db.mjs'

const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const textOrNull = value => { const text = String(value ?? '').trim(); return text || null }
const codeOf = value => String(value ?? '').trim().replace(/\.(SH|SZ|BJ)$/i, '')

export function initializeBrowserState(localDb) {
  initializeJournal(localDb)
  localDb.db.exec(`
    CREATE TABLE IF NOT EXISTS browser_state_archive (
      storage_key TEXT PRIMARY KEY, raw_value TEXT NOT NULL, migrated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_preferences (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
}

export function getDividendSelection(localDb) {
  initializeBrowserState(localDb)
  return localDb.db.prepare("SELECT value FROM app_preferences WHERE key = 'dividend_selected_code'").get()?.value ?? ''
}

export function saveDividendSelection(localDb, code) {
  initializeBrowserState(localDb)
  localDb.db.prepare(`INSERT INTO app_preferences (key, value, updated_at)
    VALUES ('dividend_selected_code', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(codeOf(code), new Date().toISOString())
  return { selectedCode: codeOf(code) }
}

function mergeLegacyValuations(localDb, state) {
  const db = localDb.db
  for (const [rawCode, legacy] of Object.entries(state?.stocks ?? {})) {
    const code = codeOf(rawCode)
    if (!code || !legacy || typeof legacy !== 'object') continue
    let current = db.prepare('SELECT * FROM dividend_records WHERE stock_code = ?').get(code)
    if (!current) {
      const known = db.prepare('SELECT 1 FROM holdings WHERE stock_code = ? UNION SELECT 1 FROM yearly_dividends WHERE stock_code = ?').get(code, code)
      if (!known) continue
      db.prepare('INSERT INTO dividend_records (stock_code) VALUES (?)').run(code)
      current = db.prepare('SELECT * FROM dividend_records WHERE stock_code = ?').get(code)
    }
    const profit = numberOrNull(legacy.estNetProfit)
    const payout = numberOrNull(legacy.estPayoutRatio)
    const targets = Array.isArray(legacy.valuationRows) ? JSON.stringify(legacy.valuationRows) : null
    const wasBlank = current.expected_net_profit == null && current.expected_dividend_yield == null
    const lastClose = db.prepare('SELECT last_close_price FROM holdings WHERE stock_code = ? AND status = ? AND last_close_price > 0 ORDER BY id LIMIT 1').get(code, 'active')?.last_close_price
    const quote = db.prepare('SELECT close_price FROM market_data WHERE stock_code = ? AND close_price > 0').get(code)?.close_price
    const price = numberOrNull(current.current_price) > 0 ? current.current_price : quote ?? lastClose ?? null
    const nextProfit = current.expected_net_profit ?? profit
    const nextPayout = wasBlank ? payout ?? current.expected_payout_ratio : current.expected_payout_ratio ?? payout
    const nextTargets = wasBlank && targets ? targets : current.valuation_targets || targets
    const shares = numberOrNull(current.total_shares)
    const yieldPct = nextProfit > 0 && nextPayout > 0 && shares > 0 && price > 0
      ? nextProfit * nextPayout / 100 / shares / price * 100 : current.expected_dividend_yield
    db.prepare(`UPDATE dividend_records SET expected_net_profit=?, expected_payout_ratio=?, valuation_targets=?,
      current_price=COALESCE(NULLIF(current_price, 0), ?), expected_dividend_yield=?, updated_at=? WHERE stock_code=?`)
      .run(nextProfit, nextPayout, nextTargets, price, yieldPct, new Date().toISOString(), code)
  }
  if (state?.selectedCode && !getDividendSelection(localDb)) saveDividendSelection(localDb, state.selectedCode)
}

function importLegacyJournal(localDb, storageKey, rawValue) {
  const db = localDb.db
  const code = codeOf(storageKey.slice('trade-journal:v1:'.length))
  if (!code) return 0
  let rows
  try { rows = JSON.parse(rawValue) } catch { return 0 }
  if (!Array.isArray(rows)) return 0
  let imported = 0
  const indexed = rows.map((row, index) => ({ row, key: `${storageKey}:${row?.id ?? index}` }))
  for (const { row, key } of indexed.filter(item => item.row?.kind !== 'review')) {
    if (!row || !['trade', 'plan'].includes(row.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date ?? '')) continue
    const result = db.prepare(`INSERT OR IGNORE INTO journal_entries
      (stock_code, holding_id, kind, action, trade_date, quantity, price, reason, judgement,
       planned_price, planned_position, result, conclusion, linked_trade_id, cost_basis,
       created_at, updated_at, legacy_key, affects_position)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)`)
      .run(code, row.kind, textOrNull(row.action), row.date,
        row.kind === 'trade' ? numberOrNull(row.quantity) : null,
        row.kind === 'trade' ? numberOrNull(row.price) : null,
        textOrNull(row.reason), textOrNull(row.judgement), textOrNull(row.plannedPrice ?? row.planned_price),
        textOrNull(row.plannedPosition ?? row.planned_position), textOrNull(row.result), textOrNull(row.conclusion),
        numberOrNull(row.costBasis ?? row.cost_basis), row.createdAt ?? new Date().toISOString(),
        new Date().toISOString(), key)
    imported += result.changes
  }
  for (const { row, key } of indexed.filter(item => item.row?.kind === 'review')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date ?? '')) continue
    const oldTradeKey = row.tradeId ? `${storageKey}:${row.tradeId}` : null
    const linkedId = oldTradeKey ? db.prepare('SELECT id FROM journal_entries WHERE legacy_key = ?').get(oldTradeKey)?.id ?? null : null
    const result = db.prepare(`INSERT OR IGNORE INTO journal_entries
      (stock_code, holding_id, kind, action, trade_date, quantity, price, reason, judgement,
       planned_price, planned_position, result, conclusion, linked_trade_id, cost_basis,
       created_at, updated_at, legacy_key, affects_position)
      VALUES (?, NULL, 'review', NULL, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, 0)`)
      .run(code, row.date, textOrNull(row.judgement), textOrNull(row.result), textOrNull(row.conclusion),
        linkedId, row.createdAt ?? new Date().toISOString(), new Date().toISOString(), key)
    imported += result.changes
  }
  return imported
}

export function migrateBrowserRecords(localDb, entries) {
  initializeBrowserState(localDb)
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('浏览器记录数量无效')
  const db = localDb.db
  let imported = 0
  db.exec('BEGIN')
  try {
    for (const item of entries) {
      const key = String(item?.key ?? '')
      const raw = item?.value
      if (key !== 'dividend_analysis_state' && !key.startsWith('trade-journal:v1:')) throw new Error('包含未知存储键')
      if (typeof raw !== 'string' || raw.length > 2_000_000) throw new Error('记录内容无效或过大')
      db.prepare(`INSERT INTO browser_state_archive (storage_key, raw_value, migrated_at) VALUES (?, ?, ?)
        ON CONFLICT(storage_key) DO UPDATE SET raw_value=excluded.raw_value, migrated_at=excluded.migrated_at`)
        .run(key, raw, new Date().toISOString())
      if (key === 'dividend_analysis_state') {
        let parsed = null
        try { parsed = JSON.parse(raw) } catch { /* 原始内容已入库，保留备份 */ }
        if (parsed) mergeLegacyValuations(localDb, parsed)
      } else imported += importLegacyJournal(localDb, key, raw)
    }
    db.exec('COMMIT')
    return { archived: entries.length, imported }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
