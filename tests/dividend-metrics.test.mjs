import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateYieldRange, summarizeHistoricalDividends } from '../src/lib/dividendMetrics.js'
test('both yields and spread follow new high and low prices', () => {
  const old = calculateYieldRange(1, 40, 25)
  const updated = calculateYieldRange(1, 30, 20)
  assert.equal(updated.max_dividend_yield, 5)
  assert.equal(updated.min_dividend_yield, 1 / 30 * 100)
  assert.equal(updated.spread, 5 - 1 / 30 * 100)
  assert.notDeepEqual(updated, old)
  assert.equal(calculateYieldRange(2, 30, 20).max_dividend_yield, 10)
})
test('historical summaries use recalculated values and exclude missing values', () => {
  const rows = [{year_low_price:20,...calculateYieldRange(1,30,20)}, {year_low_price:null,...calculateYieldRange(null,null,null)}]
  assert.deepEqual(summarizeHistoricalDividends(rows), {maxYield:5,minPrice:20,maxSpread:5 - 1 / 30 * 100})
  assert.deepEqual(summarizeHistoricalDividends([rows[1]]), {maxYield:null,minPrice:null,maxSpread:null})
  assert.equal(calculateYieldRange(0, 30, 20).max_dividend_yield, 0)
})
