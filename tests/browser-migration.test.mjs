import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLocalDatabase } from '../scripts/local-db.mjs'
import { getDividendSelection, migrateBrowserRecords } from '../scripts/browser-migration.mjs'
import { listJournalEntries } from '../scripts/journal-db.mjs'

function fixture() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-migrate-')), 'local.db')
  const db = createLocalDatabase({ dbPath, seedCsv: false })
  return { db, dbPath }
}

test('browser trades and reviews migrate once into SQLite without changing holdings, including after reopen', () => {
  const { db, dbPath } = fixture()
  db.createHolding({ stock_code: '000408', stock_name: '测试矿业', quantity: 100, cost_price: 73.98 })
  const entries = [{ key: 'trade-journal:v1:000408', value: JSON.stringify([
    { id: 'old-trade', kind: 'trade', action: '加仓', date: '2026-10-15', quantity: 100, price: 69.98, reason: '目标价触发', judgement: '低估', createdAt: '2026-10-15T01:00:00Z' },
    { id: 'old-review', kind: 'review', date: '2026-10-15', tradeId: 'old-trade', conclusion: '计划执行到位', createdAt: '2026-10-15T02:00:00Z' },
  ]) }]
  assert.equal(migrateBrowserRecords(db, entries).imported, 2)
  assert.equal(migrateBrowserRecords(db, entries).imported, 0)
  const rows = listJournalEntries(db, '000408')
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.kind === 'review').linked_trade_id, rows.find(row => row.kind === 'trade').id)
  assert.equal(rows.find(row => row.kind === 'trade').affects_position, 0)
  assert.equal(db.listHoldings()[0].quantity, 100)
  assert.equal(db.listHoldings()[0].cost_price, 73.98)
  assert.equal(db.db.prepare('SELECT raw_value FROM browser_state_archive WHERE storage_key=?').get(entries[0].key).raw_value, entries[0].value)
  db.db.close()
  const reopened = createLocalDatabase({ dbPath, seedCsv: false })
  assert.equal(listJournalEntries(reopened, '000408').length, 2)
  reopened.db.close()
})

test('legacy valuation and selected stock persist in SQLite without overwriting a complete database record', () => {
  const { db, dbPath } = fixture()
  db.createHolding({ stock_code: '600900', stock_name: '长江电力', quantity: 500, cost_price: 28.53 })
  db.db.prepare('UPDATE holdings SET last_close_price = ? WHERE stock_code = ?').run(29.45, '600900')
  db.ensureStockRows('600900', '长江电力')
  const state = { selectedCode: '600900', stocks: { '600900': { estNetProfit: '300', estPayoutRatio: '70', valuationRows: [{ yield: 5, label: '合理' }] } } }
  migrateBrowserRecords(db, [{ key: 'dividend_analysis_state', value: JSON.stringify(state) }])
  assert.equal(getDividendSelection(db), '600900')
  let record = db.getDividendRecord('600900')
  assert.equal(record.expected_net_profit, 300)
  assert.equal(record.expected_payout_ratio, 70)
  assert.equal(record.current_price, 29.45)
  assert.deepEqual(record.valuation_targets, [{ yield: 5, label: '合理' }])
  db.db.close()
  const reopened = createLocalDatabase({ dbPath, seedCsv: false })
  record = reopened.getDividendRecord('600900')
  assert.equal(record.expected_net_profit, 300)
  assert.equal(record.current_price, 29.45)
  assert.equal(getDividendSelection(reopened), '600900')
  reopened.db.close()
})

test('saved yield survives missing refresh inputs and database reopen', () => {
  const { db, dbPath } = fixture()
  db.createHolding({ stock_code: '600900', stock_name: '长江电力', quantity: 100, cost_price: 28 })
  db.ensureStockRows('600900', '长江电力')
  db.updateDividendValuation('600900', { expected_net_profit: null, total_shares: null, expected_payout_ratio: 70, current_price: 29.45, expected_dividend_yield: 5.2, valuation_targets: [] })
  assert.equal(db.listHoldings()[0].expected_dividend_yield, 5.2)
  assert.equal(db.listDividendStocks().find(row => row.stock_code === '600900').expected_dividend_yield, 5.2)
  db.applyDividendStockRefresh({ stock_code: '600900', stock_name: '长江电力', close_price: 30, daily_change_rate: 0, total_shares: null })
  assert.equal(db.getDividendRecord('600900').expected_dividend_yield, 5.2)
  db.db.close()
  const reopened = createLocalDatabase({ dbPath, seedCsv: false })
  assert.equal(reopened.listHoldings()[0].expected_dividend_yield, 5.2)
  reopened.db.close()
})

test('migration keeps a newer complete SQLite valuation and archives malformed browser data', () => {
  const { db } = fixture()
  db.createHolding({ stock_code: '600900', stock_name: '长江电力', quantity: 100, cost_price: 28 })
  db.updateDividendValuation('600900', { expected_net_profit: 350, total_shares: 200, expected_payout_ratio: 80, current_price: 30, expected_dividend_yield: 4.6666666667, valuation_targets: [{ yield: 4, label: '已保存' }] })
  const state = { selectedCode: '600900', stocks: { '600900': { estNetProfit: '100', estPayoutRatio: '35', valuationRows: [{ yield: 9, label: '旧数据' }] } } }
  migrateBrowserRecords(db, [{ key: 'dividend_analysis_state', value: JSON.stringify(state) }, { key: 'trade-journal:v1:600900', value: '{invalid-json' }])
  const record = db.getDividendRecord('600900')
  assert.equal(record.expected_net_profit, 350)
  assert.equal(record.expected_payout_ratio, 80)
  assert.deepEqual(record.valuation_targets, [{ yield: 4, label: '已保存' }])
  assert.equal(db.db.prepare('SELECT raw_value FROM browser_state_archive WHERE storage_key=?').get('trade-journal:v1:600900').raw_value, '{invalid-json')
  db.db.close()
})

test('dividend stocks use holding quote when market and saved price are missing', () => {
  const { db } = fixture()
  db.createHolding({ stock_code: '600900', stock_name: '长江电力', quantity: 100, cost_price: 28 })
  db.db.prepare('UPDATE holdings SET last_close_price=? WHERE stock_code=?').run(29.45, '600900')
  db.ensureStockRows('600900', '长江电力')
  assert.equal(db.listDividendStocks().find(row => row.stock_code === '600900').last_close_price, 29.45)
  db.db.close()
})
