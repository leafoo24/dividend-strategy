import { getJson, patchJson, postJson } from '@/lib/localApi'

export function fetchJournal(code) {
  return getJson(`/api/journal/${encodeURIComponent(code)}`)
}

export function saveJournal(code, record) {
  const path = `/api/journal/${encodeURIComponent(code)}`
  return record.id == null ? postJson(path, record) : patchJson(`${path}/${record.id}`, record)
}
