import { deleteJson, getJson } from '@/lib/localApi'

export async function fetchDividendStocks() {
  return getJson('/api/dividend-stocks')
}

export async function fetchWatchlist() {
  return getJson('/api/watchlist')
}

export async function deleteWatchlistStock(stock_code) {
  const code = String(stock_code ?? '').trim()
  if (!code) return 0
  const data = await deleteJson(`/api/holdings/by-stock/${encodeURIComponent(code)}`)
  return data?.deleted ?? 0
}
