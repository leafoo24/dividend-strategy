import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeExpectedDividends } from '../src/lib/portfolioDividends.js'
const row = (value, quantity, data) => ({ metrics: { value, quantity }, holding: data })
test('expected yield uses dividends from shares, then yield fallback, over all market value', () => {
  const result = summarizeExpectedDividends([
    row(1000, 100, { expected_dividend_per_share: 0.5, expected_dividend_yield: 99 }),
    row(3000, 100, { expected_dividend_yield: 2 }),
  ])
  assert.equal(result.amount, 110)
  assert.equal(result.yieldPct, 2.75)
  assert.equal(result.missingCount, 0)
})
test('missing predictions remain unknown and their market value stays in the denominator', () => {
  const result = summarizeExpectedDividends([
    row(1000, 100, { expected_dividend_yield: 4 }),
    row(1000, 100, { expected_dividend_yield: null }),
  ])
  assert.equal(result.amount, 40)
  assert.equal(result.yieldPct, 2)
  assert.equal(result.missingCount, 1)
  assert.equal(summarizeExpectedDividends([row(1000, 100, {})]).yieldPct, null)
})
test('zero dividends are valid; empty holdings and invalid predictions do not create a yield', () => {
  assert.equal(summarizeExpectedDividends([row(1000, 100, { expected_dividend_yield: 0 })]).yieldPct, 0)
  assert.equal(summarizeExpectedDividends([]).yieldPct, null)
  for (const value of ['', -1, Infinity, 'abc']) {
    assert.equal(summarizeExpectedDividends([row(1000, 100, { expected_dividend_yield: value })]).yieldPct, null)
  }
})
