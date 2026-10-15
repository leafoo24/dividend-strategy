import { getJson } from '@/lib/localApi'

export async function fetchDividendPlans(stockCode, { page = 1, pageSize = 5 } = {}) {
  return getJson(`/api/dividend-records/${encodeURIComponent(stockCode)}/plans?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`)
}