function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

// All years share the latest trading day's adjustment basis, not each year's last factor.
export async function refreshYearlyPrices({ records, request, tsCode, tradeDate, currentClose }) {
  const savedYear = records.find(row => Number(row.year) === Number(tradeDate.slice(0, 4)))
  const savedHigh = positive(savedYear?.year_high_price)
  const savedLow = positive(savedYear?.year_low_price)
  const close = positive(currentClose)
  // Compare at the displayed cent precision; ordinary refreshes make no annual-price requests.
  if (close && savedHigh && savedLow && savedHigh >= savedLow
    && Math.round(close * 100) >= Math.round(savedLow * 100)
    && Math.round(close * 100) <= Math.round(savedHigh * 100)) return []

  const latestRows = await request('adj_factor', { ts_code: tsCode, trade_date: tradeDate }, 'ts_code,trade_date,adj_factor')
  const latestFactor = positive(latestRows.find(row => row.trade_date === tradeDate)?.adj_factor)
  if (!latestFactor) throw new Error('最新交易日缺少有效复权因子')
  const currentYear = Number(tradeDate.slice(0, 4))
  const byYear = new Map(records.map(row => [Number(row.year), row]))
  const firstYear = Math.min(currentYear, ...byYear.keys())
  const results = []
  for (let year = firstYear; year <= currentYear; year++) {
    const old = byYear.get(year)
    if (year !== currentYear && Number(old?.price_adj_factor) === latestFactor && old?.price_asof >= `${year}1231`) continue
    const endDate = year === currentYear ? tradeDate : `${year}1231`
    const params = { ts_code: tsCode, start_date: `${year}0101`, end_date: endDate }
    const [daily, factors] = await Promise.all([
      request('daily', params, 'ts_code,trade_date,high,low,close'),
      request('adj_factor', params, 'ts_code,trade_date,adj_factor'),
    ])
    const factorMap = new Map(factors.map(row => [row.trade_date, positive(row.adj_factor)]))
    if (year === currentYear && !daily.some(row => row.trade_date === tradeDate)) throw new Error('年度日线未覆盖最新交易日')
    if (!daily.length && (old?.year_high_price != null || old?.year_low_price != null)) throw new Error(`${year} 年日线为空，保留原有价格`)
    let high = null
    let low = null
    for (const row of daily) {
      const factor = factorMap.get(row.trade_date)
      if (!factor) throw new Error(`${row.trade_date} 缺少有效复权因子`)
      const rawHigh = positive(row.high)
      const rawLow = positive(row.low)
      if (!rawHigh || !rawLow || rawHigh < rawLow) throw new Error(`${row.trade_date} 日线高低价无效`)
      const h = rawHigh * factor / latestFactor
      const l = rawLow * factor / latestFactor
      high = high == null ? h : Math.max(high, h)
      low = low == null ? l : Math.min(low, l)
    }
    if (year === currentYear && positive(currentClose) && (currentClose > high + 0.000001 || currentClose < low - 0.000001)) throw new Error('年度高低价与最新收盘价不一致')
    results.push({ year, year_high_price: high, year_low_price: low, price_adj_factor: latestFactor, price_asof: endDate })
  }
  return results
}
