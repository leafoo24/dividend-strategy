import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createLocalDatabase, getDefaultLocalDatabase } from '../scripts/local-db.mjs'
import { aggregateChina10yBondYields } from '../scripts/local-api.mjs'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dividend-local-db-'))
  return path.join(dir, 'local.db')
}

test('default local database can use configured db path', () => {
  const dbPath = tempDb()
  const previous = process.env.LOCAL_DB_PATH
  process.env.LOCAL_DB_PATH = dbPath
  try {
    const db = getDefaultLocalDatabase({ seedCsv: false })
    db.createHolding({
      stock_code: '600900',
      stock_name: 'CYPC',
      cost_price: 25,
      quantity: 100,
    })
    db.db.close()

    const reopened = createLocalDatabase({ dbPath, seedCsv: false })
    assert.deepEqual(reopened.listHoldings().map(row => row.stock_code), ['600900'])
  } finally {
    if (previous == null) delete process.env.LOCAL_DB_PATH
    else process.env.LOCAL_DB_PATH = previous
  }
})

test('local database initializes tables and seeds yearly dividends from csv', () => {
  const dbPath = tempDb()
  const csvPath = path.join(path.dirname(dbPath), 'seed.csv')
  fs.writeFileSync(csvPath, 'year,股票代码,股票名称,年内最高(前复权),年内最低(前复权),每股分红_总计,基本EPS,稀释EPS,股利支付率_计算(%)\n2025,600036.SH,测试银行,40,20,1,2,2,50\n')
  const db = createLocalDatabase({ dbPath, csvPath })

  const rows = db.getYearlyDividends('600036')
  assert.ok(rows.length > 0)
  assert.equal(rows[0].stock_code, '600036')
  assert.equal(rows[0].stock_name, '测试银行')

  const holdings = db.listHoldings()
  assert.equal(holdings.some(row => row.stock_code === '600036'), false)
  assert.ok(db.listDividendStocks().some(row => row.stock_code === '600036'))
  assert.ok(db.listWatchlist().some(row => row.stock_code === '600036'))
})

test('watchlist contains dividend stocks that are not real holdings', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.ensureStockRows('600900', 'CYPC')
  db.ensureStockRows('600036', 'CMB')
  db.createHolding({
    stock_code: '600900',
    stock_name: 'CYPC',
    cost_price: 25,
    quantity: 100,
  })

  assert.deepEqual(db.listHoldings().map(row => row.stock_code), ['600900'])
  assert.deepEqual(db.listDividendStocks().map(row => row.stock_code), ['600036', '600900'])
  assert.deepEqual(db.listWatchlist().map(row => row.stock_code), ['600036'])
})

test('deleting a watchlist stock removes its dividend valuation data', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.ensureStockRows('600036', 'CMB')
  db.db.prepare(`
    INSERT INTO yearly_dividends (stock_code, stock_name, year, dividend_per_share)
    VALUES (?, ?, ?, ?)
  `).run('600036', 'CMB', 2025, 1.2)
  db.updateDividendValuation('600036', {
    expected_net_profit: 100,
    total_shares: 10,
    expected_payout_ratio: 50,
    valuation_targets: [{ yield: 5, label: 'fair' }],
  })

  assert.deepEqual(db.listWatchlist().map(row => row.stock_code), ['600036'])

  db.softDeleteHoldingByStockCode('600036')

  assert.deepEqual(db.listWatchlist(), [])
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM dividend_records WHERE stock_code = ?').get('600036').n, 0)
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM yearly_dividends WHERE stock_code = ?').get('600036').n, 0)
})

test('csv import accepts current parenthesized high and low price headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dividend-csv-'))
  const csvPath = path.join(dir, 'stock_dividend.csv')
  fs.writeFileSync(
    csvPath,
    [
      'year,股票代码,股票名称,年内最高(前复权),年内最低(前复权),每股分红_总计,基本EPS,稀释EPS,股利支付率_计算(%)',
      '2025,000001.SZ,平安银行,12.34,8.76,0.50,1.25,1.20,40.00',
      '',
    ].join('\n'),
    'utf8',
  )

  const db = createLocalDatabase({
    dbPath: tempDb(),
    csvPath,
  })

  const row = db.getYearlyDividends('000001')[0]
  assert.equal(row.year_high_price, 12.34)
  assert.equal(row.year_low_price, 8.76)
  assert.equal(row.max_dividend_yield, 0.50 / 8.76 * 100)
  assert.equal(row.min_dividend_yield, 0.50 / 12.34 * 100)
})

test('holdings can be created, updated, and soft deleted', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })

  const created = db.createHolding({
    stock_code: '600900',
    stock_name: '闀挎睙鐢靛姏',
    cost_price: 28.5,
    quantity: 1000,
  })
  assert.equal(created.status, 'active')

  const updated = db.updateHolding(created.id, {
    stock_code: '600900',
    stock_name: '闀挎睙鐢靛姏',
    cost_price: 29,
    quantity: 1200,
  })
  assert.equal(updated.cost_price, 29)

  db.deleteHolding(created.id)
  assert.deepEqual(db.listHoldings(), [])
})

test('dividend valuation fields are persisted as json', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.ensureStockRows('600900', '闀挎睙鐢靛姏')

  db.updateDividendValuation('600900', {
    expected_net_profit: 340,
    total_shares: 244.68,
    expected_payout_ratio: 70,
    valuation_targets: [{ yield: 5, label: '鍚堢悊' }],
  })

  const record = db.getDividendRecord('600900')
  assert.equal(record.expected_net_profit, 340)
  assert.deepEqual(record.valuation_targets, [{ yield: 5, label: '鍚堢悊' }])
})

test('single stock refresh data is persisted to market data, dividend record, and holdings', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  const holding = db.createHolding({
    stock_code: '600900',
    stock_name: 'CYPC',
    cost_price: 25,
    quantity: 100,
  })

  const result = db.applyDividendStockRefresh({
    stock_code: '600900',
    stock_name: 'CYPC',
    trade_date: '20260720',
    close_price: 30,
    daily_change_rate: 1.25,
    total_shares: 244.68,
  })

  assert.equal(result.updated_holdings, 1)
  assert.equal(db.listMarketData()[0].close_price, 30)
  assert.equal(db.getDividendRecord('600900').total_shares, 244.68)

  const updated = db.listHoldings().find(row => row.id === holding.id)
  assert.equal(updated.last_close_price, 30)
  assert.equal(updated.last_change_pct, 1.25)
  assert.equal(updated.floating_pnl, 500)
  assert.equal(updated.floating_pnl_pct, 20)
})



test('china 10y bond yields use annual average for history and latest date for current year', () => {
  const rows = [
    { SOLAR_DATE: '2026-07-28 00:00:00', EMM00166466: 1.74 },
    { SOLAR_DATE: '2026-07-27 00:00:00', EMM00166466: 1.70 },
    { SOLAR_DATE: '2025-12-31 00:00:00', EMM00166466: 1.80 },
    { SOLAR_DATE: '2025-01-02 00:00:00', EMM00166466: 2.00 },
  ]

  const result = aggregateChina10yBondYields(rows, 2026)

  assert.equal(result.yieldsByYear[2026], 1.74)
  assert.equal(result.yieldsByYear[2025], 1.9)
  assert.equal(result.latestTradeDate, '2026-07-28')
})
test('bond yields are persisted by year for every stock row', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.applyDividendStockRefresh({
    stock_code: '600900',
    stock_name: 'CYPC',
    trade_date: '20260720',
    close_price: 30,
    daily_change_rate: 0,
  })
  db.db.prepare('INSERT INTO yearly_dividends (stock_code, stock_name, year, dividend_per_share, bond_yield) VALUES (?, ?, ?, ?, ?)').run('600900', 'CYPC', 2025, 1, 0)
  db.db.prepare('INSERT INTO yearly_dividends (stock_code, stock_name, year, dividend_per_share, bond_yield) VALUES (?, ?, ?, ?, ?)').run('600900', 'CYPC', 2026, 1, 0)

  const result = db.updateBondYieldsByYear({ 2025: 1.86, 2026: 1.74 })

  assert.equal(result.updated, 2)
  assert.equal(db.getYearlyDividends('600900').find(row => row.year === 2025).bond_yield, 1.86)
  assert.equal(db.getYearlyDividends('600900').find(row => row.year === 2026).bond_yield, 1.74)
})
test('watchlist is sorted by expected dividend yield descending', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  for (const [code, name] of [['600001', 'Low'], ['600002', 'High'], ['600003', 'Missing']]) {
    db.ensureStockRows(code, name)
  }
  for (const [code, profit] of [['600001', 50], ['600002', 100]]) {
    db.updateDividendValuation(code, {
      expected_net_profit: profit,
      total_shares: 10,
      expected_payout_ratio: 50,
      valuation_targets: [],
    })
    db.applyDividendStockRefresh({
      stock_code: code,
      stock_name: code,
      trade_date: '20260720',
      close_price: 5,
      daily_change_rate: 0,
      total_shares: 10,
    })
  }

  assert.deepEqual(db.listWatchlist().map(row => row.stock_code), ['600002', '600001', '600003'])
})

test('holdings and watchlist expose expected dividend yield from valuation inputs', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.createHolding({
    stock_code: '600900',
    stock_name: 'CYPC',
    cost_price: 25,
    quantity: 100,
  })
  db.ensureStockRows('600036', 'CMB')

  for (const code of ['600900', '600036']) {
    db.updateDividendValuation(code, {
      expected_net_profit: 100,
      total_shares: 10,
      expected_payout_ratio: 50,
      valuation_targets: [],
    })
    db.applyDividendStockRefresh({
      stock_code: code,
      stock_name: code,
      trade_date: '20260720',
      close_price: 5,
      daily_change_rate: 0,
      total_shares: 10,
    })
  }

  assert.equal(db.listHoldings().find(row => row.stock_code === '600900').expected_dividend_yield, 100)
  assert.equal(db.listHoldings().find(row => row.stock_code === '600900').expected_dividend_per_share, 5)
  assert.equal(db.listWatchlist().find(row => row.stock_code === '600036').expected_dividend_yield, 100)
})

test('expected dividend yield rankings use valuation inputs and current prices', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })

  for (const row of [
    ['600001', 'Alpha', 100, 50, 10, 5],
    ['600002', 'Beta', 100, 60, 10, 4],
    ['600003', 'Gamma', 100, 40, 20, 4],
    ['600004', 'Delta', 100, 30, 10, 2],
    ['600005', 'Epsilon', 100, 20, 10, 1],
    ['600006', 'Zeta', 100, 10, 10, 0.4],
    ['600007', 'No Profit', null, 80, 10, 1],
  ]) {
    const [code, name, profit, payout, shares, close] = row
    db.ensureStockRows(code, name)
    db.updateDividendValuation(code, {
      expected_net_profit: profit,
      total_shares: shares,
      expected_payout_ratio: payout,
      valuation_targets: [],
    })
    db.applyDividendStockRefresh({
      stock_code: code,
      stock_name: name,
      trade_date: '20260720',
      close_price: close,
      daily_change_rate: 0,
      total_shares: shares,
    })
  }

  const rows = db.listExpectedDividendYieldRankings()

  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map(row => row.stock_code), ['600006', '600005', '600002', '600004', '600001'])
  assert.equal(rows[0].stock_name, 'Zeta')
  assert.equal(rows[0].close_price, 0.4)
  assert.equal(rows[0].expected_dividend_yield, 250)
})

test('expected dividend yield rankings use saved current yield values', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })

  db.updateDividendValuation('600001', {
    expected_net_profit: 100,
    total_shares: 10,
    expected_payout_ratio: 50,
    current_price: 5,
    expected_dividend_yield: 3,
    valuation_targets: [],
  })
  db.updateDividendValuation('600002', {
    expected_net_profit: 100,
    total_shares: 10,
    expected_payout_ratio: 20,
    current_price: 5,
    expected_dividend_yield: 8,
    valuation_targets: [],
  })

  const rows = db.listExpectedDividendYieldRankings()

  assert.deepEqual(rows.map(row => row.stock_code), ['600002', '600001'])
  assert.equal(rows[0].close_price, 5)
  assert.equal(rows[0].expected_dividend_yield, 8)
})

test('dividend stock refresh persists current price and recalculated expected yield', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.updateDividendValuation('600900', {
    expected_net_profit: 100,
    total_shares: 10,
    expected_payout_ratio: 50,
    valuation_targets: [],
  })

  db.applyDividendStockRefresh({
    stock_code: '600900',
    stock_name: 'CYPC',
    trade_date: '20260720',
    close_price: 5,
    daily_change_rate: 0,
    total_shares: 10,
  })

  const record = db.getDividendRecord('600900')
  assert.equal(record.current_price, 5)
  assert.equal(record.expected_dividend_yield, 100)
  assert.deepEqual(db.listExpectedDividendYieldRankings().map(row => row.stock_code), ['600900'])
})
test('expected dividend yield rankings include watchlist stocks without holdings', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.ensureStockRows('600900', 'CYPC')
  db.updateDividendValuation('600900', {
    expected_net_profit: 340,
    total_shares: 244.68,
    expected_payout_ratio: 70,
    valuation_targets: [],
  })
  db.applyDividendStockRefresh({
    stock_code: '600900',
    stock_name: 'CYPC',
    trade_date: '20260720',
    close_price: 30,
    daily_change_rate: 0,
    total_shares: 244.68,
  })

  assert.equal(db.listHoldings().length, 0)
  assert.equal(db.listWatchlist().length, 1)
  assert.deepEqual(db.listExpectedDividendYieldRankings().map(row => row.stock_code), ['600900'])
  assert.deepEqual(db.listExpectedDividendYieldRefreshCandidates().map(row => row.stock_code), ['600900'])
})

test('removed dividend stocks are excluded from expected yield rankings and refresh candidates', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.createHolding({
    stock_code: '600900',
    stock_name: 'CYPC',
    cost_price: 25,
    quantity: 100,
  })
  db.updateDividendValuation('600900', {
    expected_net_profit: 340,
    total_shares: 244.68,
    expected_payout_ratio: 70,
    valuation_targets: [],
  })
  db.applyDividendStockRefresh({
    stock_code: '600900',
    stock_name: 'CYPC',
    trade_date: '20260720',
    close_price: 30,
    daily_change_rate: 0,
    total_shares: 244.68,
  })

  assert.equal(db.listExpectedDividendYieldRankings().length, 1)
  assert.equal(db.listExpectedDividendYieldRefreshCandidates().length, 1)

  db.softDeleteHoldingByStockCode('600900')

  assert.deepEqual(db.listExpectedDividendYieldRankings(), [])
  assert.deepEqual(db.listExpectedDividendYieldRefreshCandidates(), [])
  assert.deepEqual(db.listWatchlist(), [])
})

test('stale local dividend data for previously deleted stocks is purged before rankings', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.createHolding({
    stock_code: '600901',
    stock_name: 'STALE',
    cost_price: 20,
    quantity: 100,
  })
  db.updateDividendValuation('600901', {
    expected_net_profit: 100,
    total_shares: 10,
    expected_payout_ratio: 50,
    valuation_targets: [],
  })
  db.applyDividendStockRefresh({
    stock_code: '600901',
    stock_name: 'STALE',
    trade_date: '20260720',
    close_price: 5,
    daily_change_rate: 0,
    total_shares: 10,
  })
  db.db.prepare("UPDATE holdings SET status = 'deleted', deleted_at = ? WHERE stock_code = ?").run('2026-07-20T00:00:00.000Z', '600901')

  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM dividend_records WHERE stock_code = ?').get('600901').n, 1)
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM market_data WHERE stock_code = ?').get('600901').n, 1)

  assert.deepEqual(db.listExpectedDividendYieldRankings(), [])
  assert.deepEqual(db.listExpectedDividendYieldRefreshCandidates(), [])
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM dividend_records WHERE stock_code = ?').get('600901').n, 0)
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM market_data WHERE stock_code = ?').get('600901').n, 0)
})

test('annual dividend income summary is persisted with updated date and yield on holding cost', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.createHolding({ stock_code: '600900', stock_name: 'CYPC', cost_price: 25, quantity: 1000 })
  db.createHolding({ stock_code: '600036', stock_name: 'CMB', cost_price: 40, quantity: 500 })

  const saved = db.updateAnnualDividendIncome({ year: 2026, amount: 1800, updated_at: '2026-07-28T10:00:00.000Z' })
  const summary = db.getAnnualDividendIncomeSummary(2026)

  assert.equal(saved.amount, 1800)
  assert.equal(saved.updated_at, '2026-07-28T10:00:00.000Z')
  assert.equal(summary.amount, 1800)
  assert.equal(summary.total_holding_cost, 45000)
  assert.equal(summary.dividend_yield_on_cost, 4)
})

test('dividend plans are persisted, formatted, and paginated by stock', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.replaceDividendPlans('600900', [
    {
      ts_code: '600900.SH',
      end_date: '20251231',
      ann_date: '20260430',
      div_proc: '??',
      stk_div: 0,
      stk_bo_rate: 0,
      stk_co_rate: 0,
      cash_div_tax: 0.5,
      record_date: '20260710',
      ex_date: '20260713',
      imp_ann_date: '20260707',
    },
    {
      ts_code: '600900.SH',
      end_date: '20241231',
      ann_date: '20250430',
      div_proc: '??',
      stk_div: 0.1,
      stk_bo_rate: 0.2,
      stk_co_rate: 0,
      cash_div_tax: 0.35,
      record_date: '20250710',
      ex_date: '20250711',
      imp_ann_date: '20250706',
    },
  ])

  const firstPage = db.listDividendPlans('600900', { page: 1, pageSize: 1 })
  const secondPage = db.listDividendPlans('600900', { page: 2, pageSize: 1 })

  assert.equal(firstPage.total, 2)
  assert.equal(firstPage.page, 1)
  assert.equal(firstPage.pageSize, 1)
  assert.equal(firstPage.rows[0].end_date, '20251231')
  assert.equal(firstPage.rows[0].plan_text, '10\u6d3e5\u5143\uff08\u542b\u7a0e\uff09')
  assert.equal(secondPage.rows[0].plan_text, '10\u90011\u80a1\u8f6c2\u80a1\u6d3e3.5\u5143\uff08\u542b\u7a0e\uff09')
})
test('dividend plans are deduplicated by report period and plan text', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  db.replaceDividendPlans('600900', [
    {
      ts_code: '600900.SH',
      end_date: '20251231',
      ann_date: '20260430',
      stk_div: 0,
      stk_bo_rate: 0,
      stk_co_rate: 0,
      cash_div_tax: 0.79,
    },
    {
      ts_code: '600900.SH',
      end_date: '20251231',
      ann_date: '20260710',
      stk_div: 0,
      stk_bo_rate: 0,
      stk_co_rate: 0,
      cash_div_tax: 0.79,
      record_date: '20260716',
      ex_date: '20260717',
      imp_ann_date: '20260710',
    },
    {
      ts_code: '600900.SH',
      end_date: '20250930',
      ann_date: '20260205',
      stk_div: 0,
      stk_bo_rate: 0,
      stk_co_rate: 0,
      cash_div_tax: 0.21,
    },
  ])

  const plans = db.listDividendPlans('600900', { page: 1, pageSize: 5 })

  assert.equal(plans.total, 2)
  assert.equal(plans.rows[0].end_date, '20251231')
  assert.equal(plans.rows[0].plan_text, '10\u6d3e7.9\u5143\uff08\u542b\u7a0e\uff09')
  assert.equal(plans.rows[0].record_date, '20260716')
  assert.equal(plans.rows[0].ex_date, '20260717')
  assert.equal(plans.rows[0].imp_ann_date, '20260710')
})

test('market index refresh rows are persisted and listed', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })

  const result = db.applyMarketIndexRefresh([
    {
      ts_code: '000001.SH',
      index_code: '000001',
      index_name: 'SSE Composite',
      trade_date: '20260720',
      close: 3610.25,
      pct_chg: 0.56,
    },
  ])

  assert.equal(result.updated, 1)
  assert.deepEqual(db.listMarketIndexSnapshots(), [
    {
      ts_code: '000001.SH',
      index_code: '000001',
      index_name: 'SSE Composite',
      trade_date: '20260720',
      close: 3610.25,
      pct_chg: 0.56,
      updated_at: result.updated_at,
    },
  ])
})

test('portfolio targets, asset categories, and holding snapshots are persisted', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })

  db.updatePortfolioTargets([
    { asset_category: 'core_dividend', target_pct: 55 },
    { asset_category: 'gold', target_pct: 20 },
    { asset_category: 'technology', target_pct: 15 },
    { asset_category: 'cycle', target_pct: 10 },
  ])

  const targets = db.listPortfolioTargets()
  assert.equal(targets.find(row => row.asset_category === 'gold').target_pct, 20)

  const result = db.replaceHoldingsSnapshot([
    { stock_code: '600900', stock_name: '长江电力', quantity: 300, cost_price: 25, last_close_price: 30, asset_category: 'core_dividend' },
    { stock_code: '518660', stock_name: '黄金ETF工银', quantity: 1000, cost_price: 8, last_close_price: 9, asset_category: 'gold' },
  ])

  assert.equal(result.imported, 2)
  const holdings = db.listHoldings()
  assert.equal(holdings.length, 2)
  assert.equal(holdings.find(row => row.stock_code === '518660').asset_category, 'gold')
  assert.equal(holdings.find(row => row.stock_code === '600900').floating_pnl, 1500)
  assert.equal(db.listMarketData().find(row => row.stock_code === '518660').close_price, 9)
})


test('stock detail refresh payload persists metrics, announcements, and dividend summary', () => {
  const db = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  const holding = db.createHolding({
    stock_code: '600036',
    stock_name: '招商银行',
    cost_price: 36.84,
    quantity: 400,
    asset_category: 'core_dividend',
  })

  const result = db.applyStockDetailRefresh('600036', {
    stock_name: '招商银行',
    trade_date: '20260721',
    close_price: 38.71,
    daily_change_rate: 0.6,
    momentum_20d: 4.5,
    pe_ttm: 6.8,
    pb: 0.92,
    dividend_per_share_ytd: 1.972,
    dividend_paid_value_ytd: 788.8,
    holding_dividend_yield_ytd: 5.09,
    announcements: [
      {
        title: '关于利润分配方案的公告',
        summary: '每股派发现金红利。',
        published_at: '2026-03-22',
        source: '公告',
        url: 'http://static.cninfo.com.cn/example.pdf',
      },
    ],
  })

  assert.equal(result.updated_holdings, 1)
  const detail = db.getStockDetail('600036')
  assert.equal(detail.holding.id, holding.id)
  assert.equal(detail.metrics.pe_ttm, 6.8)
  assert.equal(detail.metrics.pb, 0.92)
  assert.equal(detail.metrics.momentum_20d, 4.5)
  assert.equal(detail.metrics.dividend_paid_value_ytd, 788.8)
  assert.equal(detail.announcements[0].url, 'http://static.cninfo.com.cn/example.pdf')
  assert.equal(db.listMarketData().find(row => row.stock_code === '600036').close_price, 38.71)
})


test('available cash defaults to zero, persists, and rejects invalid amounts', () => {
  const dbPath = tempDb()
  const db = createLocalDatabase({ dbPath, seedCsv: false })
  assert.equal(db.getAvailableCash().amount, 0)
  assert.equal(db.updateAvailableCash({ amount: 12345.67 }).amount, 12345.67)
  for (const amount of [-1, NaN, Infinity, '', null, 'abc', 1.234]) {
    assert.throws(() => db.updateAvailableCash({ amount }))
    assert.equal(db.getAvailableCash().amount, 12345.67)
  }
  db.db.close()
  const reopened = createLocalDatabase({ dbPath, seedCsv: false })
  assert.equal(reopened.getAvailableCash().amount, 12345.67)
  assert.equal(reopened.updateAvailableCash({ amount: 0 }).amount, 0)
  reopened.db.close()
})

test('yearly price refresh preserves dividend inputs, recalculates yields, and rolls back failed batches', () => {
  const dbPath = tempDb()
  const local = createLocalDatabase({ dbPath, seedCsv: false })
  local.db.prepare('INSERT INTO yearly_dividends (stock_code,year,dividend_per_share,payout_ratio,bond_yield) VALUES (?,?,?,?,?)').run('600900', 2025, 1, 70, 1.5)
  local.updateYearlyPrices('600900', [{year:2025,year_high_price:30,year_low_price:20,price_adj_factor:2,price_asof:'20251231'}])
  const row = local.getYearlyDividends('600900')[0]
  assert.equal(row.dividend_per_share, 1)
  assert.equal(row.payout_ratio, 70)
  assert.equal(row.bond_yield, 1.5)
  assert.equal(row.max_dividend_yield, 5)
  assert.equal(row.min_dividend_yield, 1 / 30 * 100)
  assert.throws(() => local.updateYearlyPrices('600900', [
    {year:2025,year_high_price:40,year_low_price:20,price_adj_factor:3,price_asof:'20260925'},
    {year:null,year_high_price:40,year_low_price:20,price_adj_factor:3,price_asof:'20260925'},
  ]))
  assert.equal(local.getYearlyDividends('600900')[0].year_high_price, 30)
  local.db.close()
  const reopened = createLocalDatabase({ dbPath, seedCsv: false })
  assert.equal(reopened.getYearlyDividends('600900')[0].price_adj_factor, 2)
  reopened.db.close()
})

test('watchlist reflects saved valuation changes, falls back to saved price and distinguishes missing from zero', () => {
  const local = createLocalDatabase({ dbPath: tempDb(), seedCsv: false })
  local.ensureStockRows('600983', 'Whirlpool')
  const save = overrides => local.updateDividendValuation('600983', {expected_net_profit:6,total_shares:8,expected_payout_ratio:100,current_price:10,...overrides})
  save({})
  assert.equal(local.listWatchlist()[0].expected_dividend_yield, 7.5)
  assert.equal(local.listWatchlist()[0].last_close_price, 10)
  save({expected_net_profit:4,expected_payout_ratio:80})
  assert.equal(local.listWatchlist()[0].expected_dividend_yield, 4)
  save({expected_payout_ratio:0})
  assert.equal(local.listWatchlist()[0].expected_dividend_yield, 0)
  save({expected_net_profit:null})
  assert.equal(local.listWatchlist()[0].expected_dividend_yield, null)
  local.db.close()
})
