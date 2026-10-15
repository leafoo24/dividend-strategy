import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const DEFAULT_DB_PATH = path.join(root, 'data', 'local.db')
const DEFAULT_CSV_PATH = path.join(root, 'data', 'stock_dividend.csv')

function resolveConfiguredPath(value, fallback) {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw)
}

export const ASSET_CATEGORIES = [
  { key: 'core_dividend', label: '红利' },
  { key: 'gold', label: '黄金' },
  { key: 'technology', label: '科技' },
  { key: 'cycle', label: '周期' },
]

const DEFAULT_PORTFOLIO_TARGETS = [
  { asset_category: 'core_dividend', target_pct: 60 },
  { asset_category: 'gold', target_pct: 15 },
  { asset_category: 'technology', target_pct: 15 },
  { asset_category: 'cycle', target_pct: 10 },
]

function nowIso() {
  return new Date().toISOString()
}

function normalizeStockCode(value) {
  const raw = String(value ?? '').trim()
  const upper = raw.toUpperCase()
  for (const suffix of ['.SH', '.SZ', '.BJ']) {
    if (upper.endsWith(suffix)) return raw.slice(0, -suffix.length)
  }
  return raw
}

function numOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function firstPresent(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name]
  }
  return undefined
}

function numberOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function trimOrNull(value) {
  const text = String(value ?? '').trim()
  return text ? text : null
}

function ymdOrNull(value) {
  const text = String(value ?? '').trim()
  return /^\d{8}$/.test(text) ? text : null
}

function formatRateValue(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  const scaled = n * 10
  return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function buildDividendPlanText(row) {
  const parts = []
  const stkDiv = formatRateValue(row.stk_div)
  const stkBo = formatRateValue(row.stk_bo_rate)
  const stkCo = formatRateValue(row.stk_co_rate)
  const cash = formatRateValue(row.cash_div_tax ?? row.cash_div)
  if (stkDiv) parts.push(`送${stkDiv}股`)
  if (stkBo) parts.push(`转${stkBo}股`)
  if (stkCo) parts.push(`配${stkCo}股`)
  if (cash) parts.push(`派${cash}元（含税）`)
  return parts.length ? `10${parts.join('')}` : '—'
}

function normalizeDividendPlanRow(row) {
  return {
    ...row,
    end_date: ymdOrNull(row.end_date),
    ann_date: ymdOrNull(row.ann_date),
    record_date: ymdOrNull(row.record_date),
    ex_date: ymdOrNull(row.ex_date),
    pay_date: ymdOrNull(row.pay_date),
    imp_ann_date: ymdOrNull(row.imp_ann_date),
    plan_text: trimOrNull(row.plan_text) ?? buildDividendPlanText(row),
  }
}

function dividendPlanCompleteness(row) {
  return ['record_date', 'ex_date', 'pay_date', 'imp_ann_date', 'ann_date'].reduce((score, key) => score + (row[key] ? 1 : 0), 0)
}

function dedupeDividendPlanRows(rows) {
  const byPlan = new Map()
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeDividendPlanRow(raw)
    const key = `${row.end_date ?? ''}|${row.plan_text ?? ''}`
    const prev = byPlan.get(key)
    if (!prev || dividendPlanCompleteness(row) > dividendPlanCompleteness(prev) || (dividendPlanCompleteness(row) === dividendPlanCompleteness(prev) && String(row.ann_date ?? '') > String(prev.ann_date ?? ''))) {
      byPlan.set(key, row)
    }
  }
  return Array.from(byPlan.values())
}

function normalizeAssetCategory(value) {
  const raw = String(value ?? '').trim()
  return ASSET_CATEGORIES.some(category => category.key === raw) ? raw : 'core_dividend'
}

function parseCsvLine(line) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (ch === ',' && !quoted) {
      cells.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells
}

function readCsvRows(csvPath) {
  if (!fs.existsSync(csvPath)) return []
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map(h => h.trim())
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

function backfillSavedExpectedDividendYields(db) {
  db.exec(`
    UPDATE dividend_records
    SET current_price = COALESCE(current_price, (
          SELECT close_price FROM market_data md WHERE md.stock_code = dividend_records.stock_code UNION ALL SELECT last_close_price FROM holdings h WHERE h.stock_code = dividend_records.stock_code AND h.last_close_price IS NOT NULL ORDER BY 1 DESC LIMIT 1
        )),
        expected_dividend_yield = CASE
          WHEN expected_net_profit > 0
            AND expected_payout_ratio > 0
            AND total_shares > 0
            AND COALESCE(current_price, (
              SELECT close_price FROM market_data md WHERE md.stock_code = dividend_records.stock_code UNION ALL SELECT last_close_price FROM holdings h WHERE h.stock_code = dividend_records.stock_code AND h.last_close_price IS NOT NULL ORDER BY 1 DESC LIMIT 1
            )) > 0
          THEN ((expected_net_profit * expected_payout_ratio / 100.0 / total_shares) / COALESCE(current_price, (
              SELECT close_price FROM market_data md WHERE md.stock_code = dividend_records.stock_code UNION ALL SELECT last_close_price FROM holdings h WHERE h.stock_code = dividend_records.stock_code AND h.last_close_price IS NOT NULL ORDER BY 1 DESC LIMIT 1
            )) * 100.0)
          ELSE expected_dividend_yield
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE current_price IS NULL OR expected_dividend_yield IS NULL
  `)
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL,
      stock_name TEXT,
      cost_price REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL DEFAULT 0,
      asset_category TEXT NOT NULL DEFAULT 'core_dividend',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      last_close_price REAL,
      last_change_pct REAL,
      floating_pnl REAL,
      floating_pnl_pct REAL,
      market_quotes_at TEXT
    );

    CREATE INDEX IF NOT EXISTS holdings_status_created_idx
      ON holdings(status, created_at);

    CREATE TABLE IF NOT EXISTS dividend_stock_status (
      stock_code TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portfolio_targets (
      asset_category TEXT PRIMARY KEY,
      target_pct REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dividend_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL UNIQUE,
      stock_name TEXT,
      expected_net_profit REAL,
      total_shares REAL,
      expected_payout_ratio REAL,
      current_price REAL,
      expected_dividend_yield REAL,
      valuation_targets TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS yearly_dividends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL,
      stock_name TEXT,
      year INTEGER NOT NULL,
      dividend_per_share REAL NOT NULL DEFAULT 0,
      payout_ratio REAL NOT NULL DEFAULT 0,
      year_high_price REAL,
      year_low_price REAL,
      max_dividend_yield REAL,
      min_dividend_yield REAL,
      spread REAL,
      bond_yield REAL NOT NULL DEFAULT 0,
      basic_eps REAL NOT NULL DEFAULT 0,
      diluted_eps REAL NOT NULL DEFAULT 0,
      UNIQUE(stock_code, year)
    );

    CREATE TABLE IF NOT EXISTS market_data (
      stock_code TEXT PRIMARY KEY,
      stock_name TEXT,
      close_price REAL,
      daily_change_rate REAL,
      status TEXT,
      fetched_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_detail_metrics (
      stock_code TEXT PRIMARY KEY,
      stock_name TEXT,
      trade_date TEXT,
      close_price REAL,
      daily_change_rate REAL,
      momentum_20d REAL,
      pe_ttm REAL,
      pb REAL,
      dividend_per_share_ytd REAL,
      dividend_paid_value_ytd REAL,
      holding_dividend_yield_ytd REAL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS available_cash (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annual_dividend_income (
      year INTEGER PRIMARY KEY,
      amount REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dividend_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL,
      ts_code TEXT,
      end_date TEXT,
      ann_date TEXT,
      div_proc TEXT,
      plan_text TEXT,
      stk_div REAL,
      stk_bo_rate REAL,
      stk_co_rate REAL,
      cash_div REAL,
      cash_div_tax REAL,
      record_date TEXT,
      ex_date TEXT,
      pay_date TEXT,
      imp_ann_date TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(stock_code, end_date, plan_text)
    );

    CREATE INDEX IF NOT EXISTS dividend_plans_stock_order_idx
      ON dividend_plans(stock_code, end_date DESC, ann_date DESC);


    CREATE TABLE IF NOT EXISTS stock_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      published_at TEXT,
      source TEXT,
      url TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(stock_code, title, published_at)
    );

    CREATE TABLE IF NOT EXISTS market_index_snapshots (
      ts_code TEXT PRIMARY KEY,
      index_code TEXT NOT NULL,
      index_name TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close REAL NOT NULL,
      pct_chg REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS market_sw_l3_daily (
      ts_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close REAL,
      pct_chg REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  ensureColumn(db, 'holdings', 'asset_category', "TEXT NOT NULL DEFAULT 'core_dividend'")
  ensureColumn(db, 'dividend_records', 'current_price', 'REAL')
  ensureColumn(db, 'dividend_records', 'expected_dividend_yield', 'REAL')
  ensureColumn(db, 'yearly_dividends', 'price_adj_factor', 'REAL')
  ensureColumn(db, 'yearly_dividends', 'price_asof', 'TEXT')
  backfillSavedExpectedDividendYields(db)
  seedPortfolioTargets(db)
}

function seedPortfolioTargets(db) {
  const stmt = db.prepare(`
    INSERT INTO portfolio_targets (asset_category, target_pct, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(asset_category) DO NOTHING
  `)
  const updatedAt = nowIso()
  for (const row of DEFAULT_PORTFOLIO_TARGETS) {
    stmt.run(row.asset_category, row.target_pct, updatedAt)
  }
}

function importYearlyDividendsFromCsv(db, csvPath, options = {}) {
  const rows = readCsvRows(csvPath)
  const insertYearly = db.prepare(`
    INSERT INTO yearly_dividends (
      stock_code, stock_name, year, dividend_per_share, payout_ratio,
      year_high_price, year_low_price, max_dividend_yield, min_dividend_yield,
      spread, bond_yield, basic_eps, diluted_eps
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stock_code, year) DO UPDATE SET
      stock_name = excluded.stock_name,
      dividend_per_share = excluded.dividend_per_share,
      payout_ratio = excluded.payout_ratio,
      price_adj_factor = NULL,
      price_asof = NULL,
      year_high_price = excluded.year_high_price,
      year_low_price = excluded.year_low_price,
      max_dividend_yield = excluded.max_dividend_yield,
      min_dividend_yield = excluded.min_dividend_yield,
      spread = excluded.spread,
      basic_eps = excluded.basic_eps,
      diluted_eps = excluded.diluted_eps
  `)
  const ensureRecord = db.prepare(`
    INSERT INTO dividend_records (stock_code, stock_name)
    VALUES (?, ?)
    ON CONFLICT(stock_code) DO UPDATE SET stock_name = COALESCE(dividend_records.stock_name, excluded.stock_name)
  `)
  const ensureStockStatus = db.prepare(`
    INSERT INTO dividend_stock_status (stock_code, status, deleted_at, updated_at)
    VALUES (?, 'active', NULL, ?)
    ON CONFLICT(stock_code) DO UPDATE SET
      status = 'active',
      deleted_at = NULL,
      updated_at = excluded.updated_at
  `)

  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const code = normalizeStockCode(row['股票代码'])
      if (!code) continue
      if (options.onlyCode && code !== normalizeStockCode(options.onlyCode)) continue
      const stockName = String(row['股票名称'] ?? '').trim() || null
      const year = Number.parseInt(row.year, 10)
      if (!Number.isFinite(year)) continue
      const high = numOrNull(firstPresent(row, ['年内最高(前复权)', '年内最高_前复权']))
      const low = numOrNull(firstPresent(row, ['年内最低(前复权)', '年内最低_前复权']))
      const dps = numOrNull(row['每股分红_总计']) ?? 0
      const payout = numOrNull(row['股利支付率_计算(%)']) ?? 0
      const maxYield = low && low > 0 ? dps / low * 100 : null
      const minYield = high && high > 0 ? dps / high * 100 : null
      const spread = maxYield != null && minYield != null ? maxYield - minYield : null

      insertYearly.run(
        code,
        stockName,
        year,
        dps,
        payout,
        high,
        low,
        maxYield,
        minYield,
        spread,
        0,
        numOrNull(row['基本EPS']) ?? 0,
        numOrNull(row['稀释EPS']) ?? 0,
      )
      if (options.ensureRows !== false) {
        ensureRecord.run(code, stockName)
        ensureStockStatus.run(code, nowIso())
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function seedYearlyDividends(db, csvPath) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM yearly_dividends').get().count
  if (count > 0) return
  importYearlyDividendsFromCsv(db, csvPath)
}

function calculateExpectedDividendYield({ expected_net_profit, expected_payout_ratio, total_shares, current_price }) {
  const profit = numOrNull(expected_net_profit)
  const payout = numOrNull(expected_payout_ratio)
  const shares = numOrNull(total_shares)
  const price = numOrNull(current_price)
  if (profit == null || payout == null || shares == null || price == null) return null
  if (profit <= 0 || payout <= 0 || shares <= 0 || price <= 0) return null
  return ((profit * payout / 100.0 / shares) / price) * 100.0
}

function hydrateRecord(row) {
  if (!row) return null
  return {
    ...row,
    valuation_targets:
      typeof row.valuation_targets === 'string' && row.valuation_targets
        ? JSON.parse(row.valuation_targets)
        : row.valuation_targets,
  }
}

export function createLocalDatabase(options = {}) {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH
  const csvPath = options.csvPath ?? DEFAULT_CSV_PATH
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  createSchema(db)
  if (options.seedCsv !== false) seedYearlyDividends(db, csvPath)

  function getHoldingById(id) {
    return db.prepare('SELECT * FROM holdings WHERE id = ?').get(id)
  }

  function purgeDeletedDividendLocalData() {
    const deleteMarket = db.prepare(`
      DELETE FROM market_data
      WHERE EXISTS (
        SELECT 1 FROM dividend_stock_status dss
        WHERE dss.stock_code = market_data.stock_code
          AND dss.status = 'deleted'
      )
      OR EXISTS (
        SELECT 1 FROM holdings h
        WHERE h.stock_code = market_data.stock_code
          AND h.status = 'deleted'
      )
    `).run()
    const deleteRecords = db.prepare(`
      DELETE FROM dividend_records
      WHERE EXISTS (
        SELECT 1 FROM dividend_stock_status dss
        WHERE dss.stock_code = dividend_records.stock_code
          AND dss.status = 'deleted'
      )
      OR EXISTS (
        SELECT 1 FROM holdings h
        WHERE h.stock_code = dividend_records.stock_code
          AND h.status = 'deleted'
      )
    `).run()
    return deleteMarket.changes + deleteRecords.changes
  }

  const api = {
    db,

    listHoldings() {
      return db.prepare(`
        SELECT
          h.*,
          CASE
            WHEN dr.expected_net_profit >= 0 AND dr.expected_payout_ratio >= 0 AND dr.total_shares > 0
            THEN dr.expected_net_profit * dr.expected_payout_ratio / 100.0 / dr.total_shares
            ELSE NULL
          END AS expected_dividend_per_share,
          CASE
            WHEN dr.expected_net_profit > 0
              AND dr.expected_payout_ratio > 0
              AND dr.total_shares > 0
              AND COALESCE(NULLIF(md.close_price, 0), h.last_close_price) > 0
            THEN ((dr.expected_net_profit * dr.expected_payout_ratio / 100.0 / dr.total_shares) / COALESCE(NULLIF(md.close_price, 0), h.last_close_price) * 100.0)
            ELSE dr.expected_dividend_yield
          END AS expected_dividend_yield
        FROM holdings h
        LEFT JOIN dividend_records dr ON dr.stock_code = h.stock_code
        LEFT JOIN market_data md ON md.stock_code = h.stock_code
        WHERE h.status = 'active'
          AND h.quantity > 0
        ORDER BY h.created_at ASC, h.id ASC
      `).all()
    },

    listDividendStocks() {
      return db.prepare(`
        WITH dividend_stocks AS (
          SELECT stock_code, stock_name, created_at FROM dividend_records
          UNION
          SELECT stock_code, stock_name, NULL AS created_at FROM yearly_dividends
        ), normalized AS (
          SELECT
            stock_code,
            COALESCE(NULLIF(MAX(stock_name), ''), stock_code) AS stock_name,
            MIN(created_at) AS created_at
          FROM dividend_stocks
          WHERE stock_code IS NOT NULL AND stock_code <> ''
          GROUP BY stock_code
        )
        SELECT
          'dividend-' || n.stock_code AS id,
          n.stock_code,
          n.stock_name,
          'core_dividend' AS asset_category,
          'active' AS status,
          COALESCE(n.created_at, CURRENT_TIMESTAMP) AS created_at,
          COALESCE(NULLIF(md.close_price, 0), NULLIF(dr.current_price, 0), (SELECT last_close_price FROM holdings active_h WHERE active_h.stock_code = n.stock_code AND active_h.status = 'active' AND active_h.quantity > 0 AND active_h.last_close_price > 0 ORDER BY active_h.id LIMIT 1)) AS last_close_price,
          md.daily_change_rate AS last_change_pct,
          md.fetched_at AS market_quotes_at,
          CASE
            WHEN dr.expected_net_profit >= 0
              AND dr.expected_payout_ratio >= 0
              AND dr.total_shares > 0
              AND COALESCE(NULLIF(md.close_price, 0), NULLIF(dr.current_price, 0), (SELECT last_close_price FROM holdings active_h WHERE active_h.stock_code = n.stock_code AND active_h.status = 'active' AND active_h.quantity > 0 AND active_h.last_close_price > 0 ORDER BY active_h.id LIMIT 1)) > 0
            THEN ((dr.expected_net_profit * dr.expected_payout_ratio / 100.0 / dr.total_shares) / COALESCE(NULLIF(md.close_price, 0), NULLIF(dr.current_price, 0), (SELECT last_close_price FROM holdings active_h WHERE active_h.stock_code = n.stock_code AND active_h.status = 'active' AND active_h.quantity > 0 AND active_h.last_close_price > 0 ORDER BY active_h.id LIMIT 1)) * 100.0)
            ELSE dr.expected_dividend_yield
          END AS expected_dividend_yield,
          CASE WHEN EXISTS (
            SELECT 1 FROM holdings h
            WHERE h.stock_code = n.stock_code
              AND h.status = 'active'
              AND h.quantity > 0
          ) THEN 1 ELSE 0 END AS is_holding
        FROM normalized n
        LEFT JOIN dividend_stock_status dss ON dss.stock_code = n.stock_code
        LEFT JOIN market_data md ON md.stock_code = n.stock_code
        LEFT JOIN dividend_records dr ON dr.stock_code = n.stock_code
        WHERE COALESCE(dss.status, 'active') = 'active'
        ORDER BY expected_dividend_yield IS NULL ASC, expected_dividend_yield DESC, n.stock_code ASC
      `).all()
    },

    listWatchlist() {
      return this.listDividendStocks().filter(row => !row.is_holding)
    },

    createHolding(input) {
      const code = normalizeStockCode(input.stock_code)
      const name = String(input.stock_name ?? '').trim()
      const cost = Number(input.cost_price)
      const quantity = Number(input.quantity)
      if (!code || !name || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('请填写有效的股票、成本和持仓数量')
      }
      if (db.prepare("SELECT 1 FROM holdings WHERE stock_code = ? AND status = 'active' LIMIT 1").get(code)) {
        throw new Error('这只股票已在持仓中，请编辑现有持仓或记录加仓')
      }
      const createdAt = nowIso()
      const result = db.prepare(`
        INSERT INTO holdings (stock_code, stock_name, cost_price, quantity, asset_category, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(
        code,
        name,
        cost,
        quantity,
        normalizeAssetCategory(input.asset_category),
        createdAt,
      )
      return getHoldingById(result.lastInsertRowid)
    },

    updateHolding(id, input) {
      const existing = getHoldingById(id)
      if (!existing || existing.status !== 'active') throw new Error('持仓不存在')
      const code = normalizeStockCode(input.stock_code)
      const name = String(input.stock_name ?? '').trim()
      const cost = Number(input.cost_price)
      const quantity = Number(input.quantity)
      if (!code || !name || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('请填写有效的股票、成本和持仓数量')
      }
      const journalExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal_entries'").get()
      if (journalExists && code !== existing.stock_code && db.prepare('SELECT 1 FROM journal_entries WHERE stock_code = ? LIMIT 1').get(existing.stock_code)) {
        throw new Error('该股票已有交易记录，不能修改股票代码')
      }
      if (code !== existing.stock_code && db.prepare("SELECT 1 FROM holdings WHERE stock_code = ? AND status = 'active' AND id <> ? LIMIT 1").get(code, id)) {
        throw new Error('这只股票已在持仓中')
      }
      const financialsChanged = cost !== Number(existing.cost_price) || quantity !== Number(existing.quantity)
      db.exec('BEGIN')
      try {
        // A manual edit becomes the new position baseline. Past trades stay in the journal
        // but must not be replayed over the edited quantity or cost on the next trade.
        if (financialsChanged && journalExists) {
          db.prepare("UPDATE journal_entries SET holding_id = NULL, affects_position = 0 WHERE holding_id = ? AND kind = 'trade'").run(id)
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal_baselines'").get()) {
            db.prepare('DELETE FROM journal_baselines WHERE holding_id = ?').run(id)
          }
        }
        db.prepare(`
          UPDATE holdings
          SET stock_code = ?, stock_name = ?, cost_price = ?, quantity = ?, asset_category = ?
          WHERE id = ?
        `).run(code, name, cost, quantity, normalizeAssetCategory(input.asset_category), id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return getHoldingById(id)
    },

    deleteHolding(id) {
      db.prepare(`
        UPDATE holdings
        SET status = 'deleted', deleted_at = ?
        WHERE id = ?
      `).run(nowIso(), id)
    },

    softDeleteHoldingByStockCode(stockCode) {
      const code = normalizeStockCode(stockCode)
      const deletedAt = nowIso()
      db.exec('BEGIN')
      try {
        const result = db.prepare(`
          UPDATE holdings
          SET status = 'deleted', deleted_at = ?
          WHERE stock_code = ? AND status = 'active'
        `).run(deletedAt, code)
        db.prepare(`
          INSERT INTO dividend_stock_status (stock_code, status, deleted_at, updated_at)
          VALUES (?, 'deleted', ?, ?)
          ON CONFLICT(stock_code) DO UPDATE SET
            status = 'deleted',
            deleted_at = excluded.deleted_at,
            updated_at = excluded.updated_at
        `).run(code, deletedAt, deletedAt)
        db.prepare('DELETE FROM market_data WHERE stock_code = ?').run(code)
        db.prepare('DELETE FROM dividend_records WHERE stock_code = ?').run(code)
        db.prepare('DELETE FROM yearly_dividends WHERE stock_code = ?').run(code)
        db.exec('COMMIT')
        return result.changes
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    ensureStockRows(stockCode, stockName = null) {
      const code = normalizeStockCode(stockCode)
      const name = stockName ? String(stockName).trim() : null
      db.prepare(`
        INSERT INTO dividend_records (stock_code, stock_name)
        VALUES (?, ?)
        ON CONFLICT(stock_code) DO UPDATE SET stock_name = COALESCE(dividend_records.stock_name, excluded.stock_name)
      `).run(code, name)
      db.prepare(`
        INSERT INTO dividend_stock_status (stock_code, status, deleted_at, updated_at)
        VALUES (?, 'active', NULL, ?)
        ON CONFLICT(stock_code) DO UPDATE SET
          status = 'active',
          deleted_at = NULL,
          updated_at = excluded.updated_at
      `).run(code, nowIso())
    },

    getYearlyDividends(stockCode) {
      return db.prepare(`
        SELECT * FROM yearly_dividends
        WHERE stock_code = ?
        ORDER BY year ASC
      `).all(normalizeStockCode(stockCode))
    },

    importYearlyDividendsFromCsv(options = {}) {
      importYearlyDividendsFromCsv(db, options.csvPath ?? csvPath, options)
    },

    getDividendRecord(stockCode) {
      const code = normalizeStockCode(stockCode)
      let row = db.prepare('SELECT * FROM dividend_records WHERE stock_code = ?').get(code)
      if (!row) {
        const yearly = db.prepare(`
          SELECT stock_name FROM yearly_dividends
          WHERE stock_code = ? AND stock_name IS NOT NULL
          ORDER BY year DESC LIMIT 1
        `).get(code)
        this.ensureStockRows(code, yearly?.stock_name ?? null)
        row = db.prepare('SELECT * FROM dividend_records WHERE stock_code = ?').get(code)
      }
      return {
        ...hydrateRecord(row),
        yearly_dividends: this.getYearlyDividends(code),
      }
    },

    updateDividendValuation(stockCode, fields) {
      const code = normalizeStockCode(stockCode)
      this.ensureStockRows(code)
      const existing = db.prepare('SELECT current_price FROM dividend_records WHERE stock_code = ?').get(code) ?? {}
      const currentPrice = numOrNull(fields.current_price) ?? numOrNull(existing.current_price)
      const expectedYield = numOrNull(fields.expected_dividend_yield) ?? calculateExpectedDividendYield({
        expected_net_profit: fields.expected_net_profit,
        expected_payout_ratio: fields.expected_payout_ratio,
        total_shares: fields.total_shares,
        current_price: currentPrice,
      })
      db.prepare(`
        UPDATE dividend_records
        SET expected_net_profit = ?,
            total_shares = ?,
            expected_payout_ratio = ?,
            current_price = COALESCE(?, current_price),
            expected_dividend_yield = ?,
            valuation_targets = ?,
            updated_at = ?
        WHERE stock_code = ?
      `).run(
        numOrNull(fields.expected_net_profit),
        numOrNull(fields.total_shares),
        numOrNull(fields.expected_payout_ratio),
        currentPrice,
        expectedYield,
        JSON.stringify(Array.isArray(fields.valuation_targets) ? fields.valuation_targets : []),
        nowIso(),
        code,
      )
    },


    getAvailableCash() {
      return db.prepare('SELECT amount, updated_at FROM available_cash WHERE id = 1').get() ?? { amount: 0, updated_at: null }
    },
    updateAvailableCash(input) {
      const amount = input?.amount
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER / 100 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
        throw new Error('可用现金需为非负金额，最多保留两位小数')
      }
      db.prepare('INSERT INTO available_cash (id, amount, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at').run(Math.round(amount * 100) / 100, nowIso())
      return this.getAvailableCash()
    },

    getAnnualDividendIncomeSummary(year = new Date().getFullYear()) {
      const y = Number(year)
      const row = db.prepare('SELECT year, amount, updated_at FROM annual_dividend_income WHERE year = ?').get(y) ?? null
      const holdings = this.listHoldings()
      const totalHoldingCost = holdings.reduce((sum, holding) => sum + numberOrZero(holding.cost_price) * numberOrZero(holding.quantity), 0)
      const amount = numberOrZero(row?.amount)
      return { year: y, amount, updated_at: row?.updated_at ?? null, total_holding_cost: totalHoldingCost, dividend_yield_on_cost: totalHoldingCost > 0 ? amount / totalHoldingCost * 100 : null }
    },

    updateAnnualDividendIncome(input) {
      const year = Number(input?.year ?? new Date().getFullYear())
      const amount = numberOrZero(input?.amount)
      const updatedAt = trimOrNull(input?.updated_at) ?? nowIso()
      db.prepare(`
        INSERT INTO annual_dividend_income (year, amount, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(year) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
      `).run(year, amount, updatedAt)
      return this.getAnnualDividendIncomeSummary(year)
    },

    replaceDividendPlans(stockCode, rows) {
      const code = normalizeStockCode(stockCode)
      const updatedAt = nowIso()
      const inputRows = dedupeDividendPlanRows(rows)
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM dividend_plans WHERE stock_code = ?').run(code)
        const stmt = db.prepare(`
          INSERT INTO dividend_plans (stock_code, ts_code, end_date, ann_date, div_proc, plan_text, stk_div, stk_bo_rate, stk_co_rate, cash_div, cash_div_tax, record_date, ex_date, pay_date, imp_ann_date, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const row of inputRows) {
          stmt.run(code, trimOrNull(row.ts_code), ymdOrNull(row.end_date), ymdOrNull(row.ann_date), trimOrNull(row.div_proc), trimOrNull(row.plan_text) ?? buildDividendPlanText(row), numOrNull(row.stk_div), numOrNull(row.stk_bo_rate), numOrNull(row.stk_co_rate), numOrNull(row.cash_div), numOrNull(row.cash_div_tax), ymdOrNull(row.record_date), ymdOrNull(row.ex_date), ymdOrNull(row.pay_date), ymdOrNull(row.imp_ann_date), updatedAt)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return { stock_code: code, updated: inputRows.length, updated_at: updatedAt }
    },

    listDividendPlans(stockCode, options = {}) {
      const code = normalizeStockCode(stockCode)
      const pageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 5))
      const page = Math.max(1, Number(options.page) || 1)
      const total = db.prepare('SELECT COUNT(*) AS total FROM dividend_plans WHERE stock_code = ?').get(code).total
      const rows = db.prepare(`SELECT * FROM dividend_plans WHERE stock_code = ? ORDER BY COALESCE(end_date, '') DESC, COALESCE(ann_date, '') DESC, id DESC LIMIT ? OFFSET ?`).all(code, pageSize, (page - 1) * pageSize)
      return { stock_code: code, page, pageSize, total, rows }
    },
    listPortfolioTargets() {
      seedPortfolioTargets(db)
      return ASSET_CATEGORIES.map(category => {
        const row = db.prepare('SELECT target_pct, updated_at FROM portfolio_targets WHERE asset_category = ?').get(category.key)
        return {
          asset_category: category.key,
          label: category.label,
          target_pct: row ? Number(row.target_pct) : 0,
          updated_at: row?.updated_at ?? null,
        }
      })
    },

    updatePortfolioTargets(rows) {
      const inputRows = Array.isArray(rows) ? rows : Object.entries(rows ?? {}).map(([asset_category, target_pct]) => ({ asset_category, target_pct }))
      const stmt = db.prepare(`
        INSERT INTO portfolio_targets (asset_category, target_pct, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(asset_category) DO UPDATE SET
          target_pct = excluded.target_pct,
          updated_at = excluded.updated_at
      `)
      const updatedAt = nowIso()
      db.exec('BEGIN')
      try {
        for (const row of inputRows) {
          const category = normalizeAssetCategory(row.asset_category)
          const pct = Math.max(0, numberOrZero(row.target_pct))
          stmt.run(category, pct, updatedAt)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return this.listPortfolioTargets()
    },

    replaceHoldingsSnapshot(rows) {
      const snapshot = Array.isArray(rows) ? rows : []
      const now = nowIso()
      const codes = snapshot.map(row => normalizeStockCode(row.stock_code)).filter(Boolean)
      const upsertHolding = db.prepare(`
        INSERT INTO holdings (
          stock_code, stock_name, cost_price, quantity, asset_category, status, created_at,
          last_close_price, last_change_pct, floating_pnl, floating_pnl_pct, market_quotes_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `)
      const updateByCode = db.prepare(`
        UPDATE holdings
        SET stock_name = ?, cost_price = ?, quantity = ?, asset_category = ?, status = 'active', deleted_at = NULL,
            last_close_price = ?, last_change_pct = ?, floating_pnl = ?, floating_pnl_pct = ?, market_quotes_at = ?
        WHERE stock_code = ?
      `)
      const insertMarket = db.prepare(`
        INSERT INTO market_data (stock_code, stock_name, close_price, daily_change_rate, status, fetched_at)
        VALUES (?, ?, ?, ?, 'snapshot', ?)
        ON CONFLICT(stock_code) DO UPDATE SET
          stock_name = excluded.stock_name,
          close_price = excluded.close_price,
          daily_change_rate = excluded.daily_change_rate,
          status = excluded.status,
          fetched_at = excluded.fetched_at
      `)
      const ensureRecord = db.prepare(`
        INSERT INTO dividend_records (stock_code, stock_name)
        VALUES (?, ?)
        ON CONFLICT(stock_code) DO UPDATE SET stock_name = COALESCE(excluded.stock_name, dividend_records.stock_name)
      `)

      db.exec('BEGIN')
      try {
        db.prepare(`
          UPDATE holdings
          SET status = 'deleted', deleted_at = ?
          WHERE status = 'active' AND stock_code NOT IN (${codes.map(() => '?').join(',') || "''"})
        `).run(now, ...codes)

        for (const row of snapshot) {
          const code = normalizeStockCode(row.stock_code)
          if (!code) continue
          const stockName = String(row.stock_name ?? '').trim()
          const costPrice = numberOrZero(row.cost_price)
          const quantity = numberOrZero(row.quantity)
          const close = numOrNull(row.last_close_price ?? row.close_price) ?? costPrice
          const dailyChange = numOrNull(row.last_change_pct ?? row.daily_change_rate) ?? 0
          const cost = costPrice * quantity
          const value = close * quantity
          const pnl = value - cost
          const pnlPct = cost > 0 ? pnl / cost * 100 : 0
          const category = normalizeAssetCategory(row.asset_category)

          const result = updateByCode.run(stockName, costPrice, quantity, category, close, dailyChange, pnl, pnlPct, now, code)
          if (result.changes === 0) {
            upsertHolding.run(code, stockName, costPrice, quantity, category, now, close, dailyChange, pnl, pnlPct, now)
          }
          insertMarket.run(code, stockName, close, dailyChange, now)
          ensureRecord.run(code, stockName)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }

      return { ok: true, active_holdings: this.listHoldings().length, imported: snapshot.length }
    },

    getStockDetail(stockCode) {
      const code = normalizeStockCode(stockCode)
      const holding = db.prepare(`
        SELECT * FROM holdings
        WHERE stock_code = ? AND status = 'active' AND quantity > 0
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get(code) ?? null
      const quote = db.prepare('SELECT * FROM market_data WHERE stock_code = ?').get(code) ?? null
      const metrics = db.prepare('SELECT * FROM stock_detail_metrics WHERE stock_code = ?').get(code) ?? null
      const announcements = db.prepare(`
        SELECT title, summary, published_at, source, url, updated_at
        FROM stock_announcements
        WHERE stock_code = ?
        ORDER BY published_at DESC, id DESC
        LIMIT 5
      `).all(code)
      return {
        stock_code: code,
        stock_name: metrics?.stock_name ?? holding?.stock_name ?? quote?.stock_name ?? '',
        holding,
        quote,
        metrics,
        announcements,
      }
    },

    applyStockDetailRefresh(stockCode, input) {
      const code = normalizeStockCode(stockCode)
      const stockName = String(input.stock_name ?? '').trim()
      const close = numOrNull(input.close_price)
      const pctChg = numOrNull(input.daily_change_rate) ?? 0
      const updatedAt = nowIso()
      if (!code) throw new Error('缺少股票代码')

      if (close != null) {
        db.prepare(`
          INSERT INTO market_data (stock_code, stock_name, close_price, daily_change_rate, status, fetched_at)
          VALUES (?, ?, ?, ?, 'fresh', ?)
          ON CONFLICT(stock_code) DO UPDATE SET
            stock_name = excluded.stock_name,
            close_price = excluded.close_price,
            daily_change_rate = excluded.daily_change_rate,
            status = excluded.status,
            fetched_at = excluded.fetched_at
        `).run(code, stockName || null, close, pctChg, updatedAt)
      }

      db.prepare(`
        INSERT INTO stock_detail_metrics (
          stock_code, stock_name, trade_date, close_price, daily_change_rate, momentum_20d,
          pe_ttm, pb, dividend_per_share_ytd, dividend_paid_value_ytd, holding_dividend_yield_ytd, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_code) DO UPDATE SET
          stock_name = excluded.stock_name,
          trade_date = excluded.trade_date,
          close_price = excluded.close_price,
          daily_change_rate = excluded.daily_change_rate,
          momentum_20d = excluded.momentum_20d,
          pe_ttm = excluded.pe_ttm,
          pb = excluded.pb,
          dividend_per_share_ytd = excluded.dividend_per_share_ytd,
          dividend_paid_value_ytd = excluded.dividend_paid_value_ytd,
          holding_dividend_yield_ytd = excluded.holding_dividend_yield_ytd,
          updated_at = excluded.updated_at
      `).run(
        code,
        stockName || null,
        input.trade_date ? String(input.trade_date) : null,
        close,
        pctChg,
        numOrNull(input.momentum_20d),
        numOrNull(input.pe_ttm),
        numOrNull(input.pb),
        numOrNull(input.dividend_per_share_ytd),
        numOrNull(input.dividend_paid_value_ytd),
        numOrNull(input.holding_dividend_yield_ytd),
        updatedAt,
      )

      db.prepare('DELETE FROM stock_announcements WHERE stock_code = ?').run(code)
      const insertAnnouncement = db.prepare(`
        INSERT INTO stock_announcements (stock_code, title, summary, published_at, source, url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      const announcements = Array.isArray(input.announcements) ? input.announcements.slice(0, 5) : []
      for (const item of announcements) {
        const title = String(item.title ?? '').trim()
        if (!title) continue
        insertAnnouncement.run(
          code,
          title,
          item.summary ? String(item.summary) : null,
          item.published_at ? String(item.published_at) : null,
          item.source ? String(item.source) : '公告',
          item.url ? String(item.url) : null,
          updatedAt,
        )
      }

      const holdings = db.prepare(`
        SELECT id, cost_price, quantity FROM holdings
        WHERE stock_code = ? AND status = 'active' AND quantity > 0
      `).all(code)
      let updatedHoldings = 0
      if (close != null) {
        for (const holding of holdings) {
          const costPrice = Number(holding.cost_price)
          const qty = Number(holding.quantity)
          const pnl = (close - costPrice) * qty
          const pnlPct = costPrice > 0 ? ((close - costPrice) / costPrice) * 100 : null
          db.prepare(`
            UPDATE holdings
            SET last_close_price = ?, last_change_pct = ?, floating_pnl = ?, floating_pnl_pct = ?, market_quotes_at = ?
            WHERE id = ?
          `).run(close, pctChg, pnl, pnlPct, updatedAt, holding.id)
          updatedHoldings += 1
        }
      }

      return {
        ok: true,
        stock_code: code,
        updated_holdings: updatedHoldings,
        announcements: announcements.length,
      }
    },
    updateYearlyPrices(stockCode, rows) {
      const code = normalizeStockCode(stockCode)
      const upsert = db.prepare(`INSERT INTO yearly_dividends
        (stock_code, year, year_high_price, year_low_price, price_adj_factor, price_asof)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_code, year) DO UPDATE SET
          year_high_price = excluded.year_high_price,
          year_low_price = excluded.year_low_price,
          price_adj_factor = excluded.price_adj_factor,
          price_asof = excluded.price_asof`)
      db.exec('BEGIN')
      try {
        for (const row of rows) {
          upsert.run(code, row.year, row.year_high_price, row.year_low_price, row.price_adj_factor, row.price_asof)
        }
        db.prepare(`UPDATE yearly_dividends SET
          max_dividend_yield = CASE WHEN year_low_price > 0 THEN dividend_per_share / year_low_price * 100 ELSE NULL END,
          min_dividend_yield = CASE WHEN year_high_price > 0 THEN dividend_per_share / year_high_price * 100 ELSE NULL END,
          spread = CASE WHEN year_low_price > 0 AND year_high_price > 0 THEN dividend_per_share / year_low_price * 100 - dividend_per_share / year_high_price * 100 ELSE NULL END
          WHERE stock_code = ?`).run(code)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return { updated: rows.length }
    },

    updateBondYieldsByYear(yieldsByYear) {
      const entries = Object.entries(yieldsByYear ?? {})
        .map(([year, value]) => [Number.parseInt(year, 10), numOrNull(value)])
        .filter(([year, value]) => Number.isFinite(year) && value != null)
      const stmt = db.prepare('UPDATE yearly_dividends SET bond_yield = ? WHERE year = ?')
      let updated = 0
      for (const [year, value] of entries) {
        updated += stmt.run(value, year).changes
      }
      return { ok: true, updated, years: entries.map(([year]) => year) }
    },

    applyDividendStockRefresh(input) {
      const code = normalizeStockCode(input.stock_code)
      const stockName = input.stock_name ? String(input.stock_name).trim() : null
      const close = Number(input.close_price)
      const pctChg = numOrNull(input.daily_change_rate) ?? 0
      const fetchedAt = nowIso()
      if (!code) throw new Error('缺少股票代码')
      if (!Number.isFinite(close) || close <= 0) throw new Error('缺少有效收盘价')

      this.ensureStockRows(code, stockName)
      db.prepare(`
        INSERT INTO market_data (stock_code, stock_name, close_price, daily_change_rate, status, fetched_at)
        VALUES (?, ?, ?, ?, 'fresh', ?)
        ON CONFLICT(stock_code) DO UPDATE SET
          stock_name = excluded.stock_name,
          close_price = excluded.close_price,
          daily_change_rate = excluded.daily_change_rate,
          status = excluded.status,
          fetched_at = excluded.fetched_at
      `).run(code, stockName, close, pctChg, fetchedAt)

      const totalShares = numOrNull(input.total_shares)
      const recordForYield = db.prepare('SELECT expected_net_profit, expected_payout_ratio, total_shares FROM dividend_records WHERE stock_code = ?').get(code) ?? {}
      const sharesForYield = totalShares ?? numOrNull(recordForYield.total_shares)
      const expectedYield = calculateExpectedDividendYield({
        expected_net_profit: recordForYield.expected_net_profit,
        expected_payout_ratio: recordForYield.expected_payout_ratio,
        total_shares: sharesForYield,
        current_price: close,
      })
      db.prepare(`
        UPDATE dividend_records
        SET total_shares = COALESCE(?, total_shares),
            current_price = ?,
            expected_dividend_yield = COALESCE(?, expected_dividend_yield),
            updated_at = ?
        WHERE stock_code = ?
      `).run(totalShares, close, expectedYield, fetchedAt, code)

      const holdings = db.prepare(`
        SELECT id, cost_price, quantity FROM holdings
        WHERE stock_code = ? AND status = 'active' AND quantity > 0
      `).all(code)
      let updatedHoldings = 0
      for (const holding of holdings) {
        const cost = Number(holding.cost_price)
        const qty = Number(holding.quantity)
        const pnl = (close - cost) * qty
        const pnlPct = cost > 0 ? ((close - cost) / cost) * 100 : null
        db.prepare(`
          UPDATE holdings
          SET last_close_price = ?,
              last_change_pct = ?,
              floating_pnl = ?,
              floating_pnl_pct = ?,
              market_quotes_at = ?
          WHERE id = ?
        `).run(close, pctChg, pnl, pnlPct, fetchedAt, holding.id)
        updatedHoldings += 1
      }

      return {
        ok: true,
        stock_code: code,
        trade_date: input.trade_date ?? null,
        close_price: close,
        daily_change_rate: pctChg,
        total_shares: totalShares,
        updated_holdings: updatedHoldings,
      }
    },

    listExpectedDividendYieldRankings(limit = 5) {
      purgeDeletedDividendLocalData()
      const safeLimit = Math.max(1, Math.min(50, Number.isFinite(Number(limit)) ? Number(limit) : 5))
      return db.prepare(`
        SELECT
          dr.stock_code,
          COALESCE(NULLIF(dr.stock_name, ''), dr.stock_code) AS stock_name,
          dr.current_price AS close_price,
          dr.expected_net_profit,
          dr.expected_payout_ratio,
          dr.total_shares,
          dr.expected_dividend_yield
        FROM dividend_records dr
        LEFT JOIN dividend_stock_status dss ON dss.stock_code = dr.stock_code
        WHERE COALESCE(dss.status, 'active') = 'active'
          AND dr.expected_dividend_yield IS NOT NULL
          AND dr.expected_dividend_yield > 0
          AND dr.current_price IS NOT NULL
          AND dr.current_price > 0
        ORDER BY dr.expected_dividend_yield DESC, dr.stock_code ASC
        LIMIT ?
      `).all(safeLimit)
    },

    listExpectedDividendYieldRefreshCandidates() {
      purgeDeletedDividendLocalData()
      return db.prepare(`
        SELECT dr.stock_code, COALESCE(NULLIF(dr.stock_name, ''), dr.stock_code) AS stock_name
        FROM dividend_records dr
        LEFT JOIN dividend_stock_status dss ON dss.stock_code = dr.stock_code
        WHERE COALESCE(dss.status, 'active') = 'active'
          AND dr.expected_net_profit IS NOT NULL
          AND dr.expected_net_profit > 0
          AND dr.expected_payout_ratio IS NOT NULL
          AND dr.expected_payout_ratio > 0
        ORDER BY dr.stock_code ASC
      `).all()
    },
    listMarketData() {
      return db.prepare(`
        SELECT stock_code, stock_name, close_price, daily_change_rate, status, fetched_at
        FROM market_data
      `).all()
    },

    refreshMarketData() {
      const holdings = this.listHoldings()
      let updatedHoldings = 0
      for (const holding of holdings) {
        const quote = db.prepare('SELECT * FROM market_data WHERE stock_code = ?').get(holding.stock_code)
        if (!quote || quote.close_price == null) continue
        const pnl = (Number(quote.close_price) - Number(holding.cost_price)) * Number(holding.quantity)
        const cost = Number(holding.cost_price) * Number(holding.quantity)
        db.prepare(`
          UPDATE holdings
          SET last_close_price = ?,
              last_change_pct = ?,
              floating_pnl = ?,
              floating_pnl_pct = ?,
              market_quotes_at = ?
          WHERE id = ?
        `).run(
          quote.close_price,
          quote.daily_change_rate ?? 0,
          pnl,
          cost > 0 ? pnl / cost * 100 : 0,
          nowIso(),
          holding.id,
        )
        updatedHoldings += 1
      }
      return {
        updated_market: 0,
        updated_holdings: updatedHoldings,
        holdings_total: holdings.length,
        hint: '本地 SQLite 模式：使用本地已保存行情更新持仓。',
      }
    },

    applyMarketIndexRefresh(rows) {
      const updatedAt = nowIso()
      const inputRows = Array.isArray(rows) ? rows : []
      const stmt = db.prepare(`
        INSERT INTO market_index_snapshots (
          ts_code, index_code, index_name, trade_date, close, pct_chg, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ts_code) DO UPDATE SET
          index_code = excluded.index_code,
          index_name = excluded.index_name,
          trade_date = excluded.trade_date,
          close = excluded.close,
          pct_chg = excluded.pct_chg,
          updated_at = excluded.updated_at
      `)

      db.exec('BEGIN')
      try {
        for (const row of inputRows) {
          const close = Number(row.close)
          const pctChg = Number(row.pct_chg)
          if (!row.ts_code || !row.index_code || !row.index_name || !row.trade_date) continue
          if (!Number.isFinite(close) || !Number.isFinite(pctChg)) continue
          stmt.run(
            String(row.ts_code),
            String(row.index_code),
            String(row.index_name),
            String(row.trade_date),
            close,
            pctChg,
            updatedAt,
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }

      return { updated: inputRows.length, updated_at: updatedAt }
    },

    listMarketIndexSnapshots() {
      return db.prepare('SELECT * FROM market_index_snapshots').all().map(row => ({ ...row }))
    },

    listMarketSwL3Daily() {
      return db.prepare('SELECT * FROM market_sw_l3_daily').all()
    },
  }

  return api
}

export function getDefaultLocalDatabase(options = {}) {
  return createLocalDatabase({
    ...options,
    dbPath: options.dbPath ?? resolveConfiguredPath(options.env?.LOCAL_DB_PATH ?? process.env.LOCAL_DB_PATH, DEFAULT_DB_PATH),
    csvPath: options.csvPath ?? resolveConfiguredPath(options.env?.LOCAL_CSV_PATH ?? process.env.LOCAL_CSV_PATH, DEFAULT_CSV_PATH),
  })
}
