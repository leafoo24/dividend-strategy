import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLocalDatabase } from '../scripts/local-db.mjs'
import { listJournalEntries, saveJournalEntry } from '../scripts/journal-db.mjs'

function fixture() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-db-')), 'local.db')
  const db = createLocalDatabase({ dbPath, seedCsv: false })
  const holding = db.createHolding({ stock_code: '000408', stock_name: '测试矿业', quantity: 100, cost_price: 74 })
  return { db, holding }
}

test('plans do not change holdings; trades recalculate quantity, cost and realized gain', () => {
  const { db, holding } = fixture()
  const code = holding.stock_code
  saveJournalEntry(db, code, { kind: 'plan', action: '加仓', date: '2026-10-01', judgement: '达到目标股息率', planned_price: '70 元以下' })
  assert.equal(db.db.prepare('SELECT quantity FROM holdings WHERE id=?').get(holding.id).quantity, 100)
  const add = saveJournalEntry(db, code, { kind: 'trade', action: '加仓', date: '2026-10-02', quantity: 100, price: 70, reason: '条件满足' })
  assert.equal(add.holding.quantity, 200)
  assert.equal(add.holding.cost_price, 72)
  const reduce = saveJournalEntry(db, code, { kind: 'trade', action: '减仓', date: '2026-10-03', quantity: 50, price: 80, reason: '控制仓位' })
  assert.equal(reduce.holding.quantity, 150)
  assert.equal(reduce.holding.cost_price, 72)
  assert.equal(reduce.entry.cost_basis, 72)
  assert.equal((reduce.entry.price - reduce.entry.cost_basis) * reduce.entry.quantity, 400)
  const edited = saveJournalEntry(db, code, { kind: 'trade', action: '加仓', date: '2026-10-02', quantity: 100, price: 68, reason: '更正成交价' }, add.entry.id)
  assert.equal(edited.holding.quantity, 150)
  assert.equal(edited.holding.cost_price, 71)
  assert.equal(listJournalEntries(db, code).find(row => row.id === reduce.entry.id).cost_basis, 71)
  db.db.close()
})

test('invalid reduction rolls back record and holding changes together', () => {
  const { db, holding } = fixture()
  assert.throws(() => saveJournalEntry(db, holding.stock_code, { kind: 'trade', action: '减仓', date: '2026-10-02', quantity: 100, price: 80, reason: '测试' }), /减仓股数必须小于/)
  assert.equal(db.db.prepare('SELECT quantity FROM holdings WHERE id=?').get(holding.id).quantity, 100)
  assert.equal(listJournalEntries(db, holding.stock_code).length, 0)
  db.db.close()
})

test('manual holding edit starts a new trade baseline without replaying old trades', () => {
  const { db, holding } = fixture()
  const first = saveJournalEntry(db, holding.stock_code, { kind: 'trade', action: '加仓', date: '2026-10-02', quantity: 100, price: 70, reason: '首次加仓' })
  assert.equal(first.holding.quantity, 200)
  db.updateHolding(holding.id, { stock_code: holding.stock_code, stock_name: holding.stock_name, quantity: 250, cost_price: 75, asset_category: holding.asset_category })
  const second = saveJournalEntry(db, holding.stock_code, { kind: 'trade', action: '加仓', date: '2026-10-03', quantity: 50, price: 60, reason: '再次加仓' })
  assert.equal(second.holding.quantity, 300)
  assert.equal(second.holding.cost_price, 72.5)
  assert.equal(listJournalEntries(db, holding.stock_code).find(row => row.id === first.entry.id).affects_position, 0)
  assert.equal(listJournalEntries(db, holding.stock_code).find(row => row.id === first.entry.id).holding_id, null)
  db.db.close()
})

test('holding stock code cannot change after journal entries exist', () => {
  const { db, holding } = fixture()
  saveJournalEntry(db, holding.stock_code, { kind: 'plan', action: '加仓', date: '2026-10-02', judgement: '测试计划' })
  assert.throws(() => db.updateHolding(holding.id, { stock_code: '600000', stock_name: holding.stock_name, quantity: 100, cost_price: 74, asset_category: holding.asset_category }), /不能修改股票代码/)
  assert.equal(db.db.prepare('SELECT stock_code FROM holdings WHERE id = ?').get(holding.id).stock_code, holding.stock_code)
  db.db.close()
})

test('invalid or duplicate active holdings cannot poison journal calculations', () => {
  const { db, holding } = fixture()
  assert.throws(() => db.createHolding({ stock_code: '600900', stock_name: '无效', quantity: 'abc', cost_price: 10 }), /有效的股票/)
  assert.throws(() => db.createHolding({ stock_code: holding.stock_code, stock_name: holding.stock_name, quantity: 100, cost_price: 74 }), /已在持仓中/)
  assert.throws(() => db.updateHolding(holding.id, { stock_code: holding.stock_code, stock_name: holding.stock_name, quantity: 'abc', cost_price: 74, asset_category: holding.asset_category }), /有效的股票/)
  assert.equal(db.db.prepare('SELECT quantity FROM holdings WHERE id = ?').get(holding.id).quantity, 100)
  db.db.close()
})
