import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshYearlyPrices } from '../scripts/yearly-prices.mjs'

function fixture({ factor = 2, missingFactor = false, cached = false } = {}) {
  const calls = []
  const records = [2025, 2026].map(year => ({ year, price_adj_factor: cached ? 2 : null, price_asof: cached ? '20260924' : null }))
  const request = async (api, params) => {
    calls.push([api, params])
    if (params.trade_date) return [{ trade_date: '20260925', adj_factor: factor }]
    const year = params.start_date.slice(0, 4)
    return api === 'daily'
      ? [{ trade_date: year + '0105', high: 40, low: 30 }, { trade_date: year === '2026' ? '20260925' : '20251231', high: 29, low: 28 }]
      : [{ trade_date: year + '0105', adj_factor: 1 }, ...(!missingFactor ? [{ trade_date: year === '2026' ? '20260925' : '20251231', adj_factor: 2 }] : [])]
  }
  return { calls, records, request }
}
test('first refresh recomputes intraday highs/lows on the same latest qfq basis for all years', async () => {
  const f = fixture()
  const rows = await refreshYearlyPrices({ ...f, tsCode: '600900.SH', tradeDate: '20260925' })
  assert.equal(rows.length, 2)
  assert.equal(rows[1].year_high_price, 29)
  assert.equal(rows[1].year_low_price, 15)
  assert.equal(rows[0].price_adj_factor, 2)
})
test('unchanged adjustment basis refreshes current year only; changed basis recomputes history', async () => {
  assert.equal((await refreshYearlyPrices({ ...fixture({ cached: true }), tsCode: '600900.SH', tradeDate: '20260925' })).length, 1)
  assert.equal((await refreshYearlyPrices({ ...fixture({ cached: true, factor: 3 }), tsCode: '600900.SH', tradeDate: '20260925' })).length, 2)
})
test('missing adjustment data fails instead of saving a partial annual range', async () => {
  await assert.rejects(refreshYearlyPrices({ ...fixture({ missingFactor: true }), tsCode: '600900.SH', tradeDate: '20260925' }), /复权因子/)
})
test('new year finalizes the previously unfinished year and creates the current year', async () => {
  const f = fixture({ cached: true })
  f.records = [{ year: 2025, price_adj_factor: 2, price_asof: '20251215' }]
  const rows = await refreshYearlyPrices({ ...f, tsCode: '600900.SH', tradeDate: '20260925' })
  assert.deepEqual(rows.map(r => r.year), [2025, 2026])
})

test('refresh within saved annual bounds skips all annual data requests, including rounded boundaries', async () => {
  for (const currentClose of [25, 29.57, 24.47]) {
    const f = fixture()
    f.records = [{ year: 2026, year_high_price: 29.569999, year_low_price: 24.474245 }]
    assert.deepEqual(await refreshYearlyPrices({ ...f, tsCode:'600900.SH', tradeDate:'20260925', currentClose }), [])
    assert.equal(f.calls.length, 0)
  }
})
test('a price outside either bound triggers recomputation', async () => {
  for (const [currentClose, high, low] of [[28.36,27.65,25.18], [28,30,28.5]]) {
    const f = fixture()
    f.records = [{year:2026,year_high_price:high,year_low_price:low}]
    const rows = await refreshYearlyPrices({...f,tsCode:'600900.SH',tradeDate:'20260925',currentClose})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].year_high_price, 29)
    assert.ok(f.calls.length > 0)
  }
})
