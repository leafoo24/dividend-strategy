import { getJson, patchJson } from '@/lib/localApi'

export async function fetchPortfolioTargets() {
  return getJson('/api/portfolio-targets')
}

export async function savePortfolioTargets(targets) {
  return patchJson('/api/portfolio-targets', { targets })
}

export async function fetchAvailableCash() {
  return getJson('/api/available-cash')
}
export async function saveAvailableCash(amount) {
  return patchJson('/api/available-cash', { amount })
}
