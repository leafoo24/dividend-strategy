import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TUSHARE_URL = 'http://api.tushare.pro'

/** 单次 daily 多股票逗号分隔，保守每批条数（避免 URL/参数过长） */
const TS_CHUNK = 50
/** 从「上海日历」今天起往前试的自然日数，直到拉到非空日线 */
const MAX_DAY_LOOKBACK = 20

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

/** 持仓里可能是 600000、600000.SH 等，统一 6 位数字 */
function normalizeStockCode6(raw: string): string {
  let s = String(raw ?? '').trim().toUpperCase().replace(/\s/g, '')
  for (const suf of ['.SH', '.SZ', '.BJ']) {
    if (s.endsWith(suf)) s = s.slice(0, -suf.length)
  }
  const digits = s.replace(/\D/g, '')
  if (digits.length >= 6) return digits.slice(-6)
  return digits.padStart(6, '0')
}

/** Tushare 日线 ts_code，规则见 https://tushare.pro/document/2?doc_id=27 */
function toTsCode(code6: string): string {
  const c = normalizeStockCode6(code6)
  if (c.length !== 6) return `${c}.SH`
  const a0 = c[0]
  if (a0 === '8' || a0 === '4') return `${c}.BJ`
  if (['0', '1', '2', '3'].includes(a0)) return `${c}.SZ`
  return `${c}.SH`
}

/** 某个「上海日历」自然日的 YYYYMMDD（A 股按本地日期对齐交易日） */
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
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

/**
 * 按官方示例：多股票 + start_date=end_date=同一自然日，批量拉日线。
 * https://tushare.pro/document/2?doc_id=27
 */
async function fetchDailyForDate(
  token: string,
  tsCodesUnique: string[],
  ymd: string,
): Promise<Record<string, unknown>[]> {
  const merged: Record<string, unknown>[] = []
  for (const part of chunk(tsCodesUnique, TS_CHUNK)) {
    const rows = await callTushare(
      token,
      'daily',
      { ts_code: part.join(','), start_date: ymd, end_date: ymd },
      'ts_code,trade_date,close,pct_chg',
    )
    merged.push(...rows)
  }
  return merged
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
    const { data: holdingsData, error: hErr } = await supabase
      .from('holdings')
      .select('id, stock_code, stock_name, cost_price, quantity')
      .eq('status', 'active')
    if (hErr) throw hErr
    if (!holdingsData || holdingsData.length === 0) {
      return jsonResponse({ message: 'no holdings' })
    }

    const nameMap: Record<string, string> = {}
    const tsCodesUnique: string[] = []
    const seen = new Set<string>()
    for (const h of holdingsData as { stock_code: string; stock_name: string }[]) {
      const ts = toTsCode(h.stock_code)
      nameMap[ts] = h.stock_name
      if (!seen.has(ts)) {
        seen.add(ts)
        tsCodesUnique.push(ts)
      }
    }

    let dailyRows: Record<string, unknown>[] = []
    let usedYmd = ''
    const now = Date.now()
    for (let dayBack = 0; dayBack < MAX_DAY_LOOKBACK; dayBack++) {
      const ymd = chinaYmdForUtcMillis(now - dayBack * 24 * 60 * 60 * 1000)
      try {
        const rows = await fetchDailyForDate(token, tsCodesUnique, ymd)
        if (rows.length > 0) {
          dailyRows = rows
          usedYmd = ymd
          break
        }
      } catch (e) {
        console.warn(`daily fetch ymd=${ymd} failed:`, e)
      }
    }

    const upsertRows = dailyRows.map((row) => {
      const tsCode = String(row.ts_code)
      const code = normalizeStockCode6(tsCode)
      return {
        stock_code: code,
        stock_name: nameMap[tsCode] ?? '',
        close_price: Number(row.close),
        daily_change_rate: Number(row.pct_chg),
        status: 'fresh',
        fetched_at: new Date().toISOString(),
      }
    })

    if (upsertRows.length > 0) {
      const { error: uErr } = await supabase
        .from('market_data')
        .upsert(upsertRows, { onConflict: 'stock_code' })
      if (uErr) throw uErr
    }

    const dailyByTs = new Map(dailyRows.map((row) => [String(row.ts_code), row]))
    const quotedAt = new Date().toISOString()
    let updatedHoldings = 0

    for (const h of holdingsData as { id: string; stock_code: string; cost_price: number; quantity: number }[]) {
      const row = dailyByTs.get(toTsCode(h.stock_code))
      if (!row) continue
      const close = Number(row.close)
      const pctChg = Number(row.pct_chg)
      const cost = Number(h.cost_price)
      const qty = Number(h.quantity)
      const pnl = (close - cost) * qty
      const pnlPct = cost > 0 ? ((close - cost) / cost) * 100 : null
      const { error: upErr } = await supabase
        .from('holdings')
        .update({
          last_close_price: close,
          last_change_pct: pctChg,
          floating_pnl: pnl,
          floating_pnl_pct: pnlPct,
          market_quotes_at: quotedAt,
        })
        .eq('id', h.id)
      if (upErr) throw upErr
      updatedHoldings++
    }

    return jsonResponse({
      updated_market: upsertRows.length,
      updated_holdings: updatedHoldings,
      holdings_total: holdingsData.length,
      daily_rows: dailyRows.length,
      trade_date_used: usedYmd,
      hint:
        upsertRows.length === 0
          ? `最近 ${MAX_DAY_LOOKBACK} 个自然日（上海历）均未返回日线。请核对 TUSHARE_TOKEN、积分；stock_code 是否为 6 位；北交所已按 8/4 前缀试 .BJ`
          : updatedHoldings === 0
            ? '有日线但未匹配到持仓：请检查 stock_code 与 ts_code 是否一致'
            : undefined,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return jsonResponse({ error: msg }, 500)
  }
})
