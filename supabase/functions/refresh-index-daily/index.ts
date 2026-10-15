import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TUSHARE_URL = 'http://api.tushare.pro'

/** 与页面「主要指数」一致；index_daily 每次传一个 ts_code，见 https://tushare.pro/document/2?doc_id=95 */
const MAIN_INDICES: { ts_code: string; index_code: string; index_name: string }[] = [
  { ts_code: '000001.SH', index_code: '000001', index_name: '上证指数' },
  { ts_code: '399001.SZ', index_code: '399001', index_name: '深证成指' },
  { ts_code: '399006.SZ', index_code: '399006', index_name: '创业板指' },
  { ts_code: '000300.SH', index_code: '000300', index_name: '沪深300' },
  { ts_code: '000922.SH', index_code: '000922', index_name: '中证红利' },
]

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

function pickLatestRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!rows.length) return null
  return rows.reduce((best, r) => {
    const d = String(r.trade_date ?? '')
    const bd = String(best.trade_date ?? '')
    return d > bd ? r : best
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const token = Deno.env.get('TUSHARE_TOKEN')
  if (!token) return jsonResponse({ error: 'TUSHARE_TOKEN not set' }, 500)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    const now = Date.now()
    const endYmd = chinaYmdForUtcMillis(now)
    const startYmd = chinaYmdForUtcMillis(now - 45 * 24 * 60 * 60 * 1000)

    const upsertRows: Record<string, string | number>[] = []
    const errors: string[] = []

    for (const meta of MAIN_INDICES) {
      try {
        const rows = await callTushare(
          token,
          'index_daily',
          { ts_code: meta.ts_code, start_date: startYmd, end_date: endYmd },
          'ts_code,trade_date,close,pct_chg',
        )
        const latest = pickLatestRow(rows)
        if (!latest) {
          errors.push(`${meta.index_name}: 区间内无数据`)
          continue
        }
        upsertRows.push({
          ts_code: meta.ts_code,
          index_code: meta.index_code,
          index_name: meta.index_name,
          trade_date: String(latest.trade_date),
          close: Number(latest.close),
          pct_chg: Number(latest.pct_chg),
          updated_at: new Date().toISOString(),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`${meta.index_name}: ${msg}`)
      }
    }

    if (upsertRows.length > 0) {
      const { error: uErr } = await supabase.from('market_index_snapshots').upsert(upsertRows, {
        onConflict: 'ts_code',
      })
      if (uErr) throw uErr
    }

    return jsonResponse({
      updated: upsertRows.length,
      total: MAIN_INDICES.length,
      endYmd,
      startYmd,
      errors: errors.length ? errors : undefined,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return jsonResponse({ error: msg }, 500)
  }
})
