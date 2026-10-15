import { getJson, postJson } from '@/lib/localApi'

export async function fetchMarketDataMap() {
  const data = await getJson('/api/market-data')
  return Object.fromEntries((data ?? []).map(row => [row.stock_code, row]))
}

export async function refreshMarketData() {
  return postJson('/api/refresh-market-data')
}
