import { getJson, patchJson, postJson } from '@/lib/localApi'

const ownedKey = key => key === 'dividend_analysis_state' || key.startsWith('trade-journal:v1:')

export async function migrateBrowserStorage() {
  const entries = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key && ownedKey(key)) entries.push({ key, value: localStorage.getItem(key) ?? '' })
  }
  if (!entries.length) return { archived: 0, imported: 0 }
  const result = await postJson('/api/browser-records/migrate', { entries })
  if (result.archived !== entries.length) throw new Error('数据库未确认全部记录，浏览器原始数据已保留')
  for (const entry of entries) {
    try { localStorage.removeItem(entry.key) } catch { /* SQLite 已确认迁移，保留浏览器副本供下次幂等清理 */ }
  }
  return result
}

export function fetchDividendSelection() {
  return getJson('/api/dividend-selection')
}

export function saveDividendSelection(selectedCode) {
  return patchJson('/api/dividend-selection', { selectedCode })
}
