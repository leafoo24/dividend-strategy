const clean = value => String(value ?? '').trim()
const optional = value => clean(value) || null
const stockCode = value => clean(value).replace(/\.(SH|SZ|BJ)$/i, '')

export function initializeJournal(localDb) {
  localDb.db.exec(`
    CREATE TABLE IF NOT EXISTS journal_baselines (
      holding_id INTEGER PRIMARY KEY, quantity REAL NOT NULL, cost_price REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL, holding_id INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('trade', 'plan', 'review')),
      action TEXT, trade_date TEXT NOT NULL, quantity INTEGER, price REAL,
      reason TEXT, judgement TEXT, planned_price TEXT, planned_position TEXT,
      result TEXT, conclusion TEXT, linked_trade_id INTEGER, cost_basis REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      legacy_key TEXT, affects_position INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS journal_entries_stock_idx ON journal_entries(stock_code, id);

  `)
  const columns = localDb.db.prepare('PRAGMA table_info(journal_entries)').all().map(column => column.name)
  if (!columns.includes('legacy_key')) localDb.db.exec('ALTER TABLE journal_entries ADD COLUMN legacy_key TEXT')
  if (!columns.includes('affects_position')) localDb.db.exec('ALTER TABLE journal_entries ADD COLUMN affects_position INTEGER NOT NULL DEFAULT 1')
  localDb.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_legacy_idx ON journal_entries(legacy_key)')
}

export function listJournalEntries(localDb, code) {
  initializeJournal(localDb)
  return localDb.db.prepare('SELECT * FROM journal_entries WHERE stock_code = ? ORDER BY trade_date DESC, id DESC').all(stockCode(code))
}

export function saveJournalEntry(localDb, stock, input, id = null) {
  initializeJournal(localDb)
  const db = localDb.db
  const code = stockCode(stock)
  const kind = clean(input.kind)
  const action = clean(input.action)
  const date = clean(input.date ?? input.trade_date)
  const qty = Number(input.quantity)
  const price = Number(input.price)
  const holding = db.prepare("SELECT * FROM holdings WHERE stock_code = ? AND status = 'active' AND quantity > 0 ORDER BY id LIMIT 1").get(code)
  if (!['trade', 'plan', 'review'].includes(kind)) throw new Error('记录类型无效')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || date > new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })) throw new Error('请选择有效且不晚于今天的日期')
  const importedTrade = id != null && db.prepare('SELECT affects_position FROM journal_entries WHERE id = ? AND stock_code = ?').get(id, code)?.affects_position === 0
  if (kind === 'trade') {
    if (!holding && !importedTrade) throw new Error('没有可更新的当前持仓')
    if (!['加仓', '减仓'].includes(action)) throw new Error('交易方向无效')
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) throw new Error('请填写有效的成交股数和价格')
    if (!clean(input.reason)) throw new Error('请填写成交理由')
  }
  if (kind === 'plan' && !clean(input.judgement)) throw new Error('请填写交易前判断')
  if (kind === 'review' && !clean(input.conclusion)) throw new Error('请填写复盘结论')
  const existing = id == null ? null : db.prepare('SELECT * FROM journal_entries WHERE id = ? AND stock_code = ?').get(id, code)
  if (id != null && !existing) throw new Error('记录不存在')
  if (existing && existing.kind !== kind) throw new Error('不能修改记录类型')
  const linkedId = input.linked_trade_id == null || input.linked_trade_id === '' ? null : Number(input.linked_trade_id)
  if (linkedId != null && !db.prepare("SELECT id FROM journal_entries WHERE id = ? AND stock_code = ? AND kind = 'trade'").get(linkedId, code)) throw new Error('关联交易不存在')
  const now = new Date().toISOString()
  db.exec('BEGIN')
  try {
    if (kind === 'trade' && !importedTrade && !db.prepare('SELECT 1 FROM journal_baselines WHERE holding_id = ?').get(holding.id)) {
      db.prepare('INSERT INTO journal_baselines (holding_id, quantity, cost_price) VALUES (?, ?, ?)').run(holding.id, holding.quantity, holding.cost_price)
    }
    const values = [code, kind === 'trade' && !importedTrade ? holding.id : null, kind, kind === 'review' ? null : action || null,
      date, kind === 'trade' ? qty : null, kind === 'trade' ? price : null,
      optional(input.reason), optional(input.judgement), optional(input.planned_price), optional(input.planned_position),
      kind === 'plan' ? null : optional(input.result), kind === 'plan' ? null : optional(input.conclusion), linkedId, now]
    let recordId = id
    if (existing) {
      db.prepare('UPDATE journal_entries SET stock_code=?, holding_id=?, kind=?, action=?, trade_date=?, quantity=?, price=?, reason=?, judgement=?, planned_price=?, planned_position=?, result=?, conclusion=?, linked_trade_id=?, updated_at=? WHERE id=?').run(...values, id)
    } else {
      recordId = Number(db.prepare('INSERT INTO journal_entries (stock_code, holding_id, kind, action, trade_date, quantity, price, reason, judgement, planned_price, planned_position, result, conclusion, linked_trade_id, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...values, now).lastInsertRowid)
    }
    if (kind === 'trade' && !importedTrade) {
      const baseline = db.prepare('SELECT * FROM journal_baselines WHERE holding_id = ?').get(holding.id)
      let positionQty = Number(baseline.quantity)
      let positionCost = Number(baseline.cost_price)
      for (const row of db.prepare("SELECT * FROM journal_entries WHERE holding_id = ? AND kind = 'trade' ORDER BY trade_date ASC, id ASC").all(holding.id)) {
        if (row.action === '加仓') {
          positionCost = (positionQty * positionCost + row.quantity * row.price) / (positionQty + row.quantity)
          positionQty += row.quantity
          db.prepare('UPDATE journal_entries SET cost_basis = NULL WHERE id = ?').run(row.id)
        } else {
          if (row.quantity >= positionQty) throw new Error('减仓股数必须小于当时持仓股数')
          db.prepare('UPDATE journal_entries SET cost_basis = ? WHERE id = ?').run(positionCost, row.id)
          positionQty -= row.quantity
        }
      }
      const close = Number(holding.last_close_price)
      const pnl = Number.isFinite(close) && close > 0 ? (close - positionCost) * positionQty : null
      const pnlPct = Number.isFinite(close) && close > 0 && positionCost > 0 ? (close - positionCost) / positionCost * 100 : null
      db.prepare('UPDATE holdings SET quantity=?, cost_price=?, floating_pnl=?, floating_pnl_pct=? WHERE id=?').run(positionQty, positionCost, pnl, pnlPct, holding.id)
    }
    db.exec('COMMIT')
    return { entry: db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(recordId), holding: holding ? db.prepare('SELECT * FROM holdings WHERE id = ?').get(holding.id) : null }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
