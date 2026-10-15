import { getJson, postJson } from '@/lib/localApi'

export async function fetchStockDetail(stockCode) {
  const code = String(stockCode ?? '').trim()
  if (!code) throw new Error('缺少股票代码')
  return getJson(`/api/stock-detail/${encodeURIComponent(code)}`)
}

export async function refreshStockDetail(stockCode) {
  const code = String(stockCode ?? '').trim()
  if (!code) throw new Error('缺少股票代码')
  return postJson(`/api/stock-detail/${encodeURIComponent(code)}/refresh`)
}
