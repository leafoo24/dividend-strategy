import { getJson, patchJson } from '@/lib/localApi'

export async function fetchAnnualDividendIncome(year = new Date().getFullYear()) {
  return getJson(`/api/annual-dividend-income?year=${encodeURIComponent(year)}`)
}

export async function saveAnnualDividendIncome(payload) {
  return patchJson('/api/annual-dividend-income', payload)
}