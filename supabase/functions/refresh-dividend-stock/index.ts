import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TUSHARE_URL = 'http://api.tushare.pro'
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

function normalizeStockCode6(raw: string): string {
  let s = String(raw ?? '').trim().toUpperCase().replace(/\s/g, '')
  for (const suf of ['.SH', '.SZ', '.BJ']) {
    if (s.endsWith(suf)) s = s.slice(0, -suf.length)
  }
  const digits = s.replace(/\D/g, '')
  if (digits.length >= 6) return digits.slice(-6)
  return digits.padStart(6, '0')
}

function toTsCode(code6: string): string {
  const c = normalizeStockCode6(code6)
  if (c.length !== 6) return `${c}.SH`
  const a0 = c[0]
  if (a0 === '8' || a0 === '4') return `${c}.BJ`
  if (['0', '1', '2', '3'].includes(a0)) return `${c}.SZ`
  return `${c}.SH`
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

async function fetchDailyOneDay(token: string, tsCode: string, ymd: string): Promise<Record<string, unknown> | null> {
  const rows = await callTushare(
    token,
    'daily',
    { ts_code: tsCode, start_date: ymd, end_date: ymd },
    'ts_code,trade_date,close,pct_chg',
  )
  return rows[0] ?? null
}

/** daily_basic：total_share 单位为万股，见 https://tushare.pro/document/2?doc_id=32 */
async function fetchDailyBasicOneDay(
  token: string,
  tsCode: string,
  ymd: string,
): Promise<Record<string, unknown> | null> {
  const rows = await callTushare(
    token,
    'daily_basic',
    { ts_code: tsCode, trade_date: ymd },
    'ts_code,trade_date,total_share',
  )
  return rows[0] ?? null
}

/** 万股 → 亿股（与页面「亿股」一致）：1 亿股 = 10000 万股 */
function wanGuToYiGu(wanGu: number): number {
  if (!Number.isFinite(wanGu)) return NaN
  return wanGu / 10000
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const token = Deno.env.get('TUSHARE_TOKEN')
  if (!token) return jsonResponse({ error: 'TUSHARE_TOKEN not set' }, 500)

  const sbUrl = Deno.env.get('SUPABASE_URL')
  const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!sbUrl || !sbKey) {
    return jsonResponse({ error: '缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }

  let stock_code = ''
  try {
    const body = await req.json()
    stock_code = normalizeStockCode6(String(body?.stock_code ?? ''))
  } catch {
    stock_code = ''
  }
  if (!stock_code || stock_code.length < 6) {
    return jsonResponse({ error: '缺少有效的 stock_code' }, 400)
  }

  const tsCode = toTsCode(stock_code)
  const supabase = createClient(sbUrl, sbKey)

  try {
    const { data: dr, error: drErr } = await supabase
      .from('dividend_records')
      .select('stock_code,stock_name')
      .eq('stock_code', stock_code)
      .maybeSingle()
    if (drErr) throw drErr
    const { data: h0 } = await supabase
      .from('holdings')
      .select('stock_name')
      .eq('stock_code', stock_code)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    const stockName =
      (dr as { stock_name?: string } | null)?.stock_name ?? (h0 as { stock_name?: string } | null)?.stock_name ?? ''

    let dailyRow: Record<string, unknown> | null = null
    let usedYmd = ''
    const now = Date.now()
    for (let dayBack = 0; dayBack < MAX_DAY_LOOKBACK; dayBack++) {
      const ymd = chinaYmdForUtcMillis(now - dayBack * 24 * 60 * 60 * 1000)
      try {
        const row = await fetchDailyOneDay(token, tsCode, ymd)
        if (row) {
          dailyRow = row
          usedYmd = ymd
          break
        }
      } catch (e) {
        console.warn(`daily ${ymd}:`, e)
      }
    }

    if (!dailyRow || !usedYmd) {
      throw new Error(`最近 ${MAX_DAY_LOOKBACK} 个自然日内未取到日线行情`)
    }

    const close = Number(dailyRow.close)
    const pctChg = Number(dailyRow.pct_chg)

    let totalSharesYiGu: number | null = null
    try {
      const basic = await fetchDailyBasicOneDay(token, tsCode, usedYmd)
      const shareWan = basic?.total_share
      const wanGu = typeof shareWan === 'number' ? shareWan : Number(shareWan)
      if (Number.isFinite(wanGu)) {
        totalSharesYiGu = wanGuToYiGu(wanGu)
      }
    } catch (e) {
      console.warn('daily_basic:', e)
    }

    const quotedAt = new Date().toISOString()
    const { error: mdErr } = await supabase.from('market_data').upsert(
      {
        stock_code,
        stock_name: stockName,
        close_price: close,
        daily_change_rate: pctChg,
        status: 'fresh',
        fetched_at: quotedAt,
      },
      { onConflict: 'stock_code' },
    )
    if (mdErr) throw mdErr

    if (totalSharesYiGu != null && Number.isFinite(totalSharesYiGu)) {
      const { error: upDr } = await supabase
        .from('dividend_records')
        .update({ total_shares: totalSharesYiGu })
        .eq('stock_code', stock_code)
      if (upDr) throw upDr
    }

    const { data: holdingsRows } = await supabase
      .from('holdings')
      .select('id,cost_price,quantity')
      .eq('stock_code', stock_code)
      .eq('status', 'active')

    let updatedHoldings = 0
    if (holdingsRows && holdingsRows.length > 0) {
      for (const h of holdingsRows as { id: string; cost_price: number; quantity: number }[]) {
        const cost = Number(h.cost_price)
        const qty = Number(h.quantity)
        const pnl = (close - cost) * qty
        const pnlPct = cost > 0 ? ((close - cost) / cost) * 100 : null
        const { error: hu } = await supabase
          .from('holdings')
          .update({
            last_close_price: close,
            last_change_pct: pctChg,
            floating_pnl: pnl,
            floating_pnl_pct: pnlPct,
            market_quotes_at: quotedAt,
          })
          .eq('id', h.id)
        if (hu) throw hu
        updatedHoldings++
      }
    }

    return jsonResponse({
      ok: true,
      stock_code,
      trade_date: usedYmd,
      close_price: close,
      daily_change_rate: pctChg,
      total_shares: totalSharesYiGu,
      updated_holdings: updatedHoldings,
      hint:
        totalSharesYiGu == null
          ? 'daily_basic 未返回 total_share（可能积分不足或非交易日）'
          : undefined,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return jsonResponse({ error: msg }, 500)
  }
})
