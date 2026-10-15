async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const message = body?.error || body?.message || text || `请求失败 (${res.status})`
    throw new Error(message)
  }
  return body
}

export function getJson(path) {
  return request(path)
}

export function postJson(path, body = {}) {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function patchJson(path, body = {}) {
  return request(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteJson(path) {
  return request(path, { method: 'DELETE' })
}
