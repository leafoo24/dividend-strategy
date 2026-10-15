export function calculateYieldRange(dividend, high, low) {
  const numeric = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
  const dps = numeric(dividend)
  const highPrice = numeric(high)
  const lowPrice = numeric(low)
  const maxYield = dps != null && dps >= 0 && lowPrice > 0 ? dps / lowPrice * 100 : null
  const minYield = dps != null && dps >= 0 && highPrice > 0 ? dps / highPrice * 100 : null
  return { max_dividend_yield: maxYield, min_dividend_yield: minYield, spread: maxYield != null && minYield != null ? maxYield - minYield : null }
}

export function summarizeHistoricalDividends(rows) {
  const valid = values => values.filter(value => value != null && Number.isFinite(value))
  const yields = valid(rows.map(row => row.max_dividend_yield))
  const prices = valid(rows.map(row => row.year_low_price)).filter(value => value > 0)
  const spreads = valid(rows.map(row => row.spread))
  return {
    maxYield: yields.length ? Math.max(...yields) : null,
    minPrice: prices.length ? Math.min(...prices) : null,
    maxSpread: spreads.length ? Math.max(...spreads) : null,
  }
}
