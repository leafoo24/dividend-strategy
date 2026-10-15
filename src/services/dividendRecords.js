import { getJson, patchJson, postJson } from '@/lib/localApi'

export const VALUATION_UPDATED_EVENT = 'dividend-valuation-updated'

export async function refreshDividendStock(stock_code) {
  const code = String(stock_code ?? '').trim()
  if (!code) throw new Error('缺少股票代码')
  return postJson('/api/refresh-dividend-stock', { stock_code: code })
}

function numOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function fetchDividendRecord(stock_code) {
  return getJson(`/api/dividend-records/${encodeURIComponent(stock_code)}`)
}

function sanitizeValuationTargets(rows) {
  if (!Array.isArray(rows)) return null
  return rows.map(r => ({
    yield: Number.isFinite(Number(r.yield)) ? Number(r.yield) : 0,
    label: typeof r.label === 'string' ? r.label : '',
  }))
}

export async function saveDividendValuationToSupabase(stock_code, fields) {
  const { expected_net_profit, total_shares, expected_payout_ratio, current_price, expected_dividend_yield, valuation_targets } = fields
  await patchJson(`/api/dividend-records/${encodeURIComponent(stock_code)}/valuation`, {
    expected_net_profit: numOrNull(expected_net_profit),
    total_shares: numOrNull(total_shares),
    expected_payout_ratio: numOrNull(expected_payout_ratio),
    current_price: numOrNull(current_price),
    expected_dividend_yield: numOrNull(expected_dividend_yield),
    valuation_targets: sanitizeValuationTargets(valuation_targets),
  })
  window.dispatchEvent(new CustomEvent(VALUATION_UPDATED_EVENT, { detail: { stock_code } }))
}
