import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TUSHARE_URL = 'http://api.tushare.pro'

/**
 * 设为 true 时：不调用 Tushare、不写库，直接返回 disabled（例如积分不足）。
 * 恢复时改为 false 并重新部署：`supabase functions deploy refresh-sw-l3-daily`
 */
const REFRESH_SW_L3_DISABLED = true

/** index_daily 回看自然日区间（长假后可略拉长） */
const LOOKBACK_DAYS = 60
/** 并发不宜过高，避免触发 Tushare 每分钟访问上限 */
const INDEX_DAILY_CONCURRENCY = 3
/** 每批之间停顿（毫秒），进一步降低限频概率 */
const INTER_BATCH_DELAY_MS = 250
const INSERT_CHUNK = 400

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** index_classify 的 index_code 可能不带 .SI 后缀 */
function normalizeSwTsCode(raw: string): string {
  let c = String(raw ?? '').trim()
  if (!c) return ''
  c = c.replace(/\.si$/i, '.SI')
  if (c.endsWith('.SI')) return c
  return `${c}.SI`
}

/** is_pub 各环境取值不一：仅明确「未发布」时排除，其余保留，避免筛空 */
function isSwIndexPublished(pub: unknown): boolean {
  if (pub === 0 || pub === '0' || pub === false) return false
  if (typeof pub === 'string' && pub.trim() === '0') return false
  return true
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function chinaYmdForUtcMillis(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  return `${y}${m}${d}`
}

async function callTushare(token: string, apiName: string, params: Record<string, string>, fields: string) {
  const res = await fetch(TUSHARE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token, params, fields }),
  })
  if (!res.ok) throw new Error(`Tushare HTTP ${res.status}`)
  const json = await res.json()
  if (json.code !== 0) throw new Error(`Tushare error: ${json.msg}`)
  const data = json.data
  if (!data || !Array.isArray(data.items)) return [] as Record<string, unknown>[]
  const cols: string[] = data.fields
  return data.items.map((row: unknown[]) =>
    Object.fromEntries(cols.map((col: string, i: number) => [col, row[i]])),
  )
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function pickLatestRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!rows.length) return null
  return rows.reduce((best, r) => {
    const d = String(r.trade_date ?? '')
    const bd = String(best.trade_date ?? '')
    return d > bd ? r : best
  })
}

/** 申万 2021 三级：代码 -> 行业名（index_daily 不含名称） */
async function fetchSwL3PublishedMap(token: string): Promise<Map<string, string>> {
  const rows = await callTushare(
    token,
    'index_classify',
    { level: 'L3', src: 'SW2021' },
    'index_code,industry_code,industry_name,is_pub,level',
  )
  const map = new Map<string, string>()
  for (const r of rows) {
    const lvl = r.level != null ? String(r.level).toUpperCase() : ''
    if (lvl && lvl !== 'L3') continue
    /** 必须用「指数代码」拉 index_daily；优先 index_code，其次 industry_code（部分返回指数代码在后者） */
    const rawCode = String(r.index_code || r.industry_code || '').trim()
    const tsCode = normalizeSwTsCode(rawCode)
    if (!tsCode || tsCode === '.SI') continue
    if (!isSwIndexPublished(r.is_pub)) continue
    map.set(tsCode, String(r.industry_name ?? '').trim() || tsCode)
  }
  return map
}

/** https://tushare.pro/document/2?doc_id=95 — 单指数 ts_code 一次请求 */
async function fetchLatestIndexDaily(
  token: string,
  ts_code: string,
  startYmd: string,
  endYmd: string,
): Promise<Record<string, unknown> | null> {
  const rows = await callTushare(
    token,
    'index_daily',
    { ts_code, start_date: startYmd, end_date: endYmd },
    'ts_code,trade_date,close,pct_chg',
  )
  return pickLatestRow(rows)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (REFRESH_SW_L3_DISABLED) {
    return jsonResponse({
      disabled: true,
      updated: 0,
      message:
        '申万三级行情刷新已停用。积分充足后请将 REFRESH_SW_L3_DISABLED 设为 false 并重新部署 Edge。',
    })
  }

  const token = Deno.env.get('TUSHARE_TOKEN')
  if (!token) return jsonResponse({ error: 'TUSHARE_TOKEN not set' }, 500)

  const sbUrl = Deno.env.get('SUPABASE_URL')
  const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!sbUrl || !sbKey) {
    return jsonResponse({ error: '缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（Edge Secrets）' }, 500)
  }

  const supabase = createClient(sbUrl, sbKey)

  try {
    const l3Map = await fetchSwL3PublishedMap(token)
    if (l3Map.size === 0) {
      throw new Error('index_classify 未返回可用的申万三级代码（请确认积分与 src=SW2021）')
    }

    const now = Date.now()
    const endYmd = chinaYmdForUtcMillis(now)
    const startYmd = chinaYmdForUtcMillis(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

    const codes = [...l3Map.keys()]
    const upsertPayload: Record<string, string | number | null>[] = []
    const errors: string[] = []

    const batches = chunk(codes, INDEX_DAILY_CONCURRENCY)
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]
      if (INTER_BATCH_DELAY_MS > 0 && b > 0) await sleep(INTER_BATCH_DELAY_MS)

      const settled = await Promise.allSettled(
        batch.map(async (ts_code) => {
          const latest = await fetchLatestIndexDaily(token, ts_code, startYmd, endYmd)
          const name = l3Map.get(ts_code) ?? ts_code
          if (!latest) return null
          const pctRaw = latest.pct_chg
          const pct = typeof pctRaw === 'number' ? pctRaw : Number(pctRaw)
          if (!Number.isFinite(pct)) return null
          const closeRaw = latest.close
          const close = typeof closeRaw === 'number' ? closeRaw : Number(closeRaw)
          return {
            ts_code,
            name,
            trade_date: String(latest.trade_date ?? ''),
            close: Number.isFinite(close) ? close : null,
            pct_chg: pct,
            updated_at: new Date().toISOString(),
          }
        }),
      )

      for (let i = 0; i < settled.length; i++) {
        const s = settled[i]
        const ts_code = batch[i]
        if (s.status === 'fulfilled') {
          if (s.value) upsertPayload.push(s.value)
          else errors.push(`${ts_code}: 区间内无 index_daily 数据`)
        } else {
          const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
          errors.push(`${ts_code}: ${msg}`)
        }
      }
    }

    if (upsertPayload.length === 0) {
      const sample = errors.slice(0, 8).join(' | ')
      throw new Error(
        `未能写入任何申万三级行情。可能原因：积分/权限、接口限频、或 index_daily 不支持该类代码。示例错误：${sample || '无明细'}`,
      )
    }

    /** 清空快照：neq 恒真条件，兼容 PostgREST 对 delete 需带过滤的要求 */
    const { error: delErr } = await supabase.from('market_sw_l3_daily').delete().neq('ts_code', '')
    if (delErr) throw new Error(`清空 market_sw_l3_daily 失败：${delErr.message}`)

    for (const part of chunk(upsertPayload, INSERT_CHUNK)) {
      const { error: insErr } = await supabase.from('market_sw_l3_daily').insert(part)
      if (insErr) throw new Error(`写入 market_sw_l3_daily 失败：${insErr.message}（请确认已执行迁移）`)
    }

    let tradeDateMax = ''
    for (const r of upsertPayload) {
      const td = String(r.trade_date ?? '')
      if (td > tradeDateMax) tradeDateMax = td
    }

    return jsonResponse({
      updated: upsertPayload.length,
      l3_classify_count: l3Map.size,
      trade_date_max: tradeDateMax || undefined,
      /** 仅摘要，避免响应过大 */
      errors_sample: errors.length ? errors.slice(0, 15) : undefined,
      errors_total: errors.length,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return jsonResponse({ error: msg }, 500)
  }
})
