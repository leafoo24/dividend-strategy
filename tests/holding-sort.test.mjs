import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SORTABLE_HOLDING_COLUMNS,
  getNextHoldingSort,
  sortHoldingsForDisplay,
} from '../src/lib/holdingSort.js'

function row(overrides) {
  return {
    holding: {
      id: overrides.id,
      expected_dividend_yield: overrides.expected_dividend_yield,
    },
    metrics: {
      close: overrides.close,
      value: overrides.value,
      quantity: overrides.quantity,
      costPrice: overrides.costPrice,
      pnl: overrides.pnl,
    },
  }
}

test('holding list can sort expected dividend yield descending with missing values last', () => {
  const rows = [
    row({ id: 'low', expected_dividend_yield: 3.2, close: 10, value: 1000, quantity: 100, costPrice: 9, pnl: 100 }),
    row({ id: 'missing', expected_dividend_yield: null, close: 8, value: 800, quantity: 100, costPrice: 8, pnl: 0 }),
    row({ id: 'high', expected_dividend_yield: 6.8, close: 12, value: 1200, quantity: 100, costPrice: 11, pnl: 100 }),
  ]

  const sorted = sortHoldingsForDisplay(rows, { key: 'expectedYield', direction: 'desc' })

  assert.deepEqual(sorted.map(item => item.holding.id), ['high', 'low', 'missing'])
})

test('holding list can sort by all requested numeric columns', () => {
  const rows = [
    row({ id: 'a', expected_dividend_yield: 3.2, close: 11, value: 2000, quantity: 200, costPrice: 9, pnl: 200 }),
    row({ id: 'b', expected_dividend_yield: 6.8, close: 13, value: 1000, quantity: 100, costPrice: 7, pnl: 500 }),
  ]

  const expectedAsc = {
    close: ['a', 'b'],
    value: ['b', 'a'],
    quantity: ['b', 'a'],
    costPrice: ['b', 'a'],
    pnl: ['a', 'b'],
    expectedYield: ['a', 'b'],
  }

  for (const { key } of SORTABLE_HOLDING_COLUMNS) {
    const sorted = sortHoldingsForDisplay(rows, { key, direction: 'asc' })
    assert.deepEqual(sorted.map(item => item.holding.id), expectedAsc[key], `${key} should sort ascending by its numeric value`)
  }
})

test('clicking the same holding sort toggles direction and a new column starts descending', () => {
  assert.deepEqual(getNextHoldingSort(null, 'expectedYield'), { key: 'expectedYield', direction: 'desc' })
  assert.deepEqual(getNextHoldingSort({ key: 'expectedYield', direction: 'desc' }, 'expectedYield'), { key: 'expectedYield', direction: 'asc' })
  assert.deepEqual(getNextHoldingSort({ key: 'expectedYield', direction: 'asc' }, 'close'), { key: 'close', direction: 'desc' })
})
