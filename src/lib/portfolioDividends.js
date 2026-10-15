function nonnegativeNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function summarizeExpectedDividends(rows) {
  let amount = 0
  let totalValue = 0
  let missingCount = 0
  let coveredCount = 0
  for (const { holding, metrics } of rows) {
    totalValue += metrics.value
    const perShare = nonnegativeNumber(holding.expected_dividend_per_share)
    const yieldPct = nonnegativeNumber(holding.expected_dividend_yield)
    if (perShare != null) {
      amount += perShare * metrics.quantity
      coveredCount++
    } else if (yieldPct != null) {
      amount += metrics.value * yieldPct / 100
      coveredCount++
    } else {
      missingCount++
    }
  }
  return { amount: coveredCount ? amount : null, yieldPct: totalValue > 0 && coveredCount ? amount / totalValue * 100 : null, missingCount }
}
