export const SORTABLE_HOLDING_COLUMNS = [
  { key: 'close', label: '股价' },
  { key: 'value', label: '市值' },
  { key: 'quantity', label: '持股数量' },
  { key: 'costPrice', label: '成本价' },
  { key: 'pnl', label: '浮动盈亏' },
  { key: 'expectedYield', label: '预期股息率' },
]

const VALUE_READERS = {
  close: row => row.metrics.close,
  value: row => row.metrics.value,
  quantity: row => row.metrics.quantity,
  costPrice: row => row.metrics.costPrice,
  pnl: row => row.metrics.pnl,
  expectedYield: row => row.holding.expected_dividend_yield,
}

function numericValue(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function getNextHoldingSort(currentSort, key) {
  if (currentSort?.key === key) {
    return { key, direction: currentSort.direction === 'desc' ? 'asc' : 'desc' }
  }
  return { key, direction: 'desc' }
}

export function sortHoldingsForDisplay(rows, sort) {
  const reader = VALUE_READERS[sort?.key]
  if (!reader) return rows

  const direction = sort.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = numericValue(reader(a.row))
      const bv = numericValue(reader(b.row))
      if (av == null && bv == null) return a.index - b.index
      if (av == null) return 1
      if (bv == null) return -1
      if (av === bv) return a.index - b.index
      return av > bv ? direction : -direction
    })
    .map(item => item.row)
}
