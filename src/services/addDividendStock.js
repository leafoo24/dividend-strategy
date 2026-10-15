/**
 * 开发环境：由 Vite 中间件执行 get_model.py + 同步 Supabase。
 * 生产构建无该 API，调用会失败。
 */
export async function addDividendStock(query) {
  const res = await fetch('/api/dividend/add-stock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: String(query ?? '').trim() }),
  })
  const text = await res.text()
  let body = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    /* 非 JSON 错误页 */
  }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || text || `请求失败 (${res.status})`)
  }
  return body
}
