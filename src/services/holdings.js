import { deleteJson, getJson, patchJson, postJson } from '@/lib/localApi'

export async function fetchHoldings() {
  return getJson('/api/holdings')
}

export async function createHolding(payload) {
  return postJson('/api/holdings', { ...payload, status: 'active' })
}

export async function updateHolding(id, payload) {
  return patchJson(`/api/holdings/${id}`, payload)
}

export async function deleteHolding(id) {
  await deleteJson(`/api/holdings/${id}`)
}

export async function softDeleteHoldingByStockCode(stock_code) {
  const code = String(stock_code ?? '').trim()
  if (!code) return 0
  const data = await deleteJson(`/api/holdings/by-stock/${encodeURIComponent(code)}`)
  return data?.deleted ?? 0
}
