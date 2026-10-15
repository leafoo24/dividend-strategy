import { getDividendSelection, saveDividendSelection, migrateBrowserRecords } from './browser-migration.mjs'
import { listJournalEntries, saveJournalEntry } from './journal-db.mjs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDefaultLocalDatabase } from './local-db.mjs'
import { refreshYearlyPrices } from './yearly-prices.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

function runNodeScript(script, args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        code: typeof err?.code === 'number' ? err.code : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

function parseLastJson(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/).reverse()) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      return JSON.parse(text)
    } catch {
      /* keep looking */
    }
  }
  return null
}

const TUSHARE_URL = 'http://api.tushare.pro'
const MAX_DAY_LOOKBACK = 20
const CNINFO_ANNOUNCEMENT_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query'
const EASTMONEY_TREASURY_YIELD_URL = 'https://datacenter-web.eastmoney.com/api/data/get'
const CHINA_10Y_BOND_FIELD = 'EMM00166466'
const BOND_YIELD_CACHE_MS = 30 * 60 * 1000
let bondYieldCache = null
const MAIN_INDICES = [
  { ts_code: '000001.SH', index_code: '000001', index_name: '上证指数' },
  { ts_code: '399001.SZ', index_code: '399001', index_name: '深证成指' },
  { ts_code: '399006.SZ', index_code: '399006', index_name: '创业板指' },
  { ts_code: '000300.SH', index_code: '000300', index_name: '沪深300' },
  { ts_code: '000922.SH', index_code: '000922', index_name: '中证红利' },
]

function normalizeStockCode6(raw) {
  let value = String(raw ?? '').trim().toUpperCase().replace(/\s/g, '')
  for (const suffix of ['.SH', '.SZ', '.BJ']) {
    if (value.endsWith(suffix)) value = value.slice(0, -suffix.length)
  }
  const digits = value.replace(/\D/g, '')
  if (digits.length >= 6) return digits.slice(-6)
  return digits.padStart(6, '0')
}

function toTsCode(code6) {
  const code = normalizeStockCode6(code6)
  if (code.length !== 6) return `${code}.SH`
  const first = code[0]
  if (first === '8' || first === '4') return `${code}.BJ`
  if (['0', '1', '2', '3'].includes(first)) return `${code}.SZ`
  return `${code}.SH`
}

function chinaYmdForUtcMillis(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const year = parts.find(part => part.type === 'year')?.value ?? '1970'
  const month = parts.find(part => part.type === 'month')?.value ?? '01'
  const day = parts.find(part => part.type === 'day')?.value ?? '01'
  return `${year}${month}${day}`
}

async function callTushare(token, apiName, params, fields) {
  const res = await fetch(TUSHARE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token, params, fields }),
  })
  if (!res.ok) throw new Error(`Tushare HTTP ${res.status}`)
  const json = await res.json()
  if (json.code !== 0) throw new Error(`Tushare error: ${json.msg}`)
  const data = json.data
  if (!data || !Array.isArray(data.items)) return []
  const cols = data.fields
  return data.items.map(row => Object.fromEntries(cols.map((col, index) => [col, row[index]])))
}

function parseEastmoneyDate(value) {
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? match[0] : ''
}

export function aggregateChina10yBondYields(rows, currentYear = new Date().getFullYear()) {
  const historical = new Map()
  let latestCurrent = null
  for (const row of Array.isArray(rows) ? rows : []) {
    const tradeDate = parseEastmoneyDate(row.SOLAR_DATE)
    const value = Number(row[CHINA_10Y_BOND_FIELD])
    if (!tradeDate || !Number.isFinite(value)) continue
    const year = Number.parseInt(tradeDate.slice(0, 4), 10)
    if (!Number.isFinite(year)) continue
    if (year === currentYear) {
      if (!latestCurrent || tradeDate > latestCurrent.tradeDate) latestCurrent = { tradeDate, value }
      continue
    }
    if (year < currentYear) {
      const bucket = historical.get(year) ?? { sum: 0, count: 0 }
      bucket.sum += value
      bucket.count += 1
      historical.set(year, bucket)
    }
  }

  const yieldsByYear = {}
  for (const [year, bucket] of historical.entries()) {
    if (bucket.count > 0) yieldsByYear[year] = Number((bucket.sum / bucket.count).toFixed(4))
  }
  if (latestCurrent) yieldsByYear[currentYear] = latestCurrent.value
  return {
    yieldsByYear,
    latestTradeDate: latestCurrent?.tradeDate ?? null,
    latestYield: latestCurrent?.value ?? null,
  }
}

async function fetchEastmoneyTreasuryYieldRows(minYear) {
  if (bondYieldCache && Date.now() - bondYieldCache.fetchedAt < BOND_YIELD_CACHE_MS) return bondYieldCache.rows
  const rows = []
  const pageSize = 500
  for (let page = 1; page <= 30; page += 1) {
    const url = new URL(EASTMONEY_TREASURY_YIELD_URL)
    url.searchParams.set('type', 'RPTA_WEB_TREASURYYIELD')
    url.searchParams.set('sty', 'ALL')
    url.searchParams.set('st', 'SOLAR_DATE')
    url.searchParams.set('sr', '-1')
    url.searchParams.set('p', String(page))
    url.searchParams.set('ps', String(pageSize))
    const res = await fetch(url, {
      headers: {
        Referer: 'https://data.eastmoney.com/cjsj/zmgzsyl.html',
        'User-Agent': 'Mozilla/5.0',
      },
    })
    if (!res.ok) throw new Error(`Eastmoney treasury yield HTTP ${res.status}`)
    const json = await res.json()
    const pageRows = Array.isArray(json?.result?.data) ? json.result.data : []
    rows.push(...pageRows)
    const oldestYear = pageRows
      .map(row => Number.parseInt(parseEastmoneyDate(row.SOLAR_DATE).slice(0, 4), 10))
      .filter(Number.isFinite)
      .at(-1)
    const totalPages = Number(json?.result?.pages)
    if (!pageRows.length || (Number.isFinite(oldestYear) && oldestYear <= minYear) || (Number.isFinite(totalPages) && page >= totalPages)) break
  }
  bondYieldCache = { fetchedAt: Date.now(), rows }
  return rows
}

export async function refreshChina10yBondYields(localDb) {
  const years = localDb.db.prepare('SELECT DISTINCT year FROM yearly_dividends ORDER BY year').all()
    .map(row => Number(row.year))
    .filter(Number.isFinite)
  if (!years.length) return { ok: true, updated: 0, years: [] }
  const minYear = Math.min(...years)
  const currentYear = new Date().getFullYear()
  const rows = await fetchEastmoneyTreasuryYieldRows(minYear)
  const aggregated = aggregateChina10yBondYields(rows, currentYear)
  const wanted = new Set(years)
  const yieldsByYear = Object.fromEntries(Object.entries(aggregated.yieldsByYear).filter(([year]) => wanted.has(Number(year))))
  const saved = localDb.updateBondYieldsByYear(yieldsByYear)
  return { ...saved, latest_trade_date: aggregated.latestTradeDate, latest_yield: aggregated.latestYield }
}

async function fetchDailyOneDay(token, tsCode, ymd) {
  const rows = await callTushare(
    token,
    'daily',
    { ts_code: tsCode, start_date: ymd, end_date: ymd },
    'ts_code,trade_date,close,pct_chg',
  )
  return rows[0] ?? null
}

async function fetchDailyBasicOneDay(token, tsCode, ymd) {
  const rows = await callTushare(
    token,
    'daily_basic',
    { ts_code: tsCode, trade_date: ymd },
    'ts_code,trade_date,total_share',
  )
  return rows[0] ?? null
}

function wanGuToYiGu(wanGu) {
  const n = Number(wanGu)
  return Number.isFinite(n) ? n / 10000 : null
}

function pickLatestRow(rows) {
  if (!rows.length) return null
  return rows.reduce((best, row) => {
    const d = String(row.trade_date ?? '')
    const bestDate = String(best.trade_date ?? '')
    return d > bestDate ? row : best
  })
}
function cninfoColumnForCode(code6) {
  const first = String(code6 ?? '')[0]
  return ['0', '1', '2', '3'].includes(first) ? 'szse' : 'sse'
}

function cninfoOrgIdForCode(code6) {
  const code = normalizeStockCode6(code6)
  const padded = code.padStart(7, '0')
  return cninfoColumnForCode(code) === 'szse' ? `gssz${padded}` : `gssh${padded}`
}
function formatCninfoDate(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return ''
  const ymd = chinaYmdForUtcMillis(n)
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

async function fetchCninfoAnnouncements(stockCode, pageSize = 5) {
  const code = normalizeStockCode6(stockCode)
  const params = new URLSearchParams({
    stock: `${code},${cninfoOrgIdForCode(code)}`,
    tabName: 'fulltext',
    pageSize: String(pageSize),
    pageNum: '1',
    column: cninfoColumnForCode(code),
    plate: '',
    searchkey: '',
    secid: '',
    category: '',
    trade: '',
    seDate: '',
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  })
  const res = await fetch(CNINFO_ANNOUNCEMENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice',
      'User-Agent': 'Mozilla/5.0',
    },
    body: params.toString(),
  })
  if (!res.ok) throw new Error(`CNINFO HTTP ${res.status}`)
  const json = await res.json()
  const rows = Array.isArray(json.announcements) ? json.announcements : []
  return rows.slice(0, pageSize).map(row => {
    const title = String(row.announcementTitle ?? '').replace(/<[^>]+>/g, '').trim()
    const adjunctUrl = String(row.adjunctUrl ?? '').trim()
    return {
      title,
      summary: row.announcementTypeName ? String(row.announcementTypeName) : '',
      published_at: formatCninfoDate(row.announcementTime),
      source: '公告',
      url: adjunctUrl ? `http://static.cninfo.com.cn/${adjunctUrl}` : null,
    }
  }).filter(row => row.title)
}

async function fetchDailyRows(token, tsCode, startYmd, endYmd) {
  return callTushare(
    token,
    'daily',
    { ts_code: tsCode, start_date: startYmd, end_date: endYmd },
    'ts_code,trade_date,close,pct_chg',
  )
}

async function fetchLatestDailyBasic(token, tsCode, ymd) {
  const rows = await callTushare(
    token,
    'daily_basic',
    { ts_code: tsCode, trade_date: ymd },
    'ts_code,trade_date,total_share,pe_ttm,pb',
  )
  return rows[0] ?? null
}

function calcMomentum20d(rows) {
  const ordered = [...rows]
    .filter(row => Number.isFinite(Number(row.close)) && row.trade_date)
    .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
  if (ordered.length < 21) return null
  const latest = Number(ordered.at(-1).close)
  const base = Number(ordered.at(-21).close)
  return base > 0 ? (latest / base - 1) * 100 : null
}

async function fetchDividendPerShareYtd(token, tsCode, year) {
  const rows = await callTushare(
    token,
    'dividend',
    { ts_code: tsCode },
    'ts_code,end_date,ann_date,div_proc,cash_div,cash_div_tax,record_date,ex_date,pay_date',
  )
  const today = chinaYmdForUtcMillis(Date.now())
  return rows.reduce((sum, row) => {
    const payDate = String(row.pay_date || row.ex_date || row.record_date || '')
    if (!payDate.startsWith(String(year)) || payDate > today) return sum
    const cash = Number(row.cash_div_tax ?? row.cash_div)
    return Number.isFinite(cash) ? sum + cash : sum
  }, 0)
}

async function refreshStockDetailFromSources(localDb, env, rawStockCode) {
  const token = String(env.TUSHARE_TOKEN || process.env.TUSHARE_TOKEN || '').trim()
  if (!token) throw new Error('TUSHARE_TOKEN not set')

  const stockCode = normalizeStockCode6(rawStockCode)
  const tsCode = toTsCode(stockCode)
  const holding = localDb.listHoldings().find(row => row.stock_code === stockCode)
  const record = localDb.getDividendRecord(stockCode)
  const stockName = holding?.stock_name || record?.stock_name || ''
  const now = Date.now()
  const endYmd = chinaYmdForUtcMillis(now)
  const startYmd = chinaYmdForUtcMillis(now - 75 * 24 * 60 * 60 * 1000)
  const warnings = []

  const dailyRows = await fetchDailyRows(token, tsCode, startYmd, endYmd)
  const latestDaily = pickLatestRow(dailyRows)
  if (!latestDaily) throw new Error('最近区间内未取到日线行情')
  const tradeDate = String(latestDaily.trade_date)
  const close = Number(latestDaily.close)
  const pctChg = Number(latestDaily.pct_chg)

  let basic = null
  try {
    basic = await fetchLatestDailyBasic(token, tsCode, tradeDate)
  } catch (error) {
    warnings.push(`daily_basic: ${error.message || String(error)}`)
  }

  let announcements = []
  try {
    announcements = await fetchCninfoAnnouncements(stockCode, 5)
  } catch (error) {
    warnings.push(`巨潮公告: ${error.message || String(error)}`)
  }

  let dpsYtd = null
  const isDividendHolding = holding?.asset_category === 'core_dividend'
  if (isDividendHolding) {
    try {
      dpsYtd = await fetchDividendPerShareYtd(token, tsCode, Number(endYmd.slice(0, 4)))
    } catch (error) {
      warnings.push(`dividend: ${error.message || String(error)}`)
      const yearly = localDb.getYearlyDividends(stockCode).find(row => Number(row.year) === Number(endYmd.slice(0, 4)))
      dpsYtd = yearly ? Number(yearly.dividend_per_share) : null
    }
  }

  const quantity = Number(holding?.quantity ?? 0)
  const dividendPaidValue = dpsYtd != null ? dpsYtd * quantity : null
  const holdingValue = Number.isFinite(close) ? close * quantity : 0
  const dividendYield = dividendPaidValue != null && holdingValue > 0 ? dividendPaidValue / holdingValue * 100 : null

  const result = localDb.applyStockDetailRefresh(stockCode, {
    stock_name: stockName,
    trade_date: tradeDate,
    close_price: close,
    daily_change_rate: Number.isFinite(pctChg) ? pctChg : 0,
    momentum_20d: calcMomentum20d(dailyRows),
    pe_ttm: basic?.pe_ttm,
    pb: basic?.pb,
    dividend_per_share_ytd: isDividendHolding ? dpsYtd : null,
    dividend_paid_value_ytd: isDividendHolding ? dividendPaidValue : null,
    holding_dividend_yield_ytd: isDividendHolding ? dividendYield : null,
    announcements,
  })
  return { ...result, detail: localDb.getStockDetail(stockCode), warnings: warnings.length ? warnings : undefined }
}

async function refreshMarketIndicesFromTushare(localDb, env) {
  const token = String(env.TUSHARE_TOKEN || process.env.TUSHARE_TOKEN || '').trim()
  if (!token) throw new Error('TUSHARE_TOKEN not set')

  const now = Date.now()
  const endYmd = chinaYmdForUtcMillis(now)
  const startYmd = chinaYmdForUtcMillis(now - 45 * 24 * 60 * 60 * 1000)
  const rowsToSave = []
  const errors = []

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
        errors.push(`${meta.index_name}: 鍖洪棿鍐呮棤鏁版嵁`)
        continue
      }
      rowsToSave.push({
        ts_code: meta.ts_code,
        index_code: meta.index_code,
        index_name: meta.index_name,
        trade_date: String(latest.trade_date),
        close: Number(latest.close),
        pct_chg: Number(latest.pct_chg),
      })
    } catch (error) {
      errors.push(`${meta.index_name}: ${error.message || String(error)}`)
    }
  }

  const saved = localDb.applyMarketIndexRefresh(rowsToSave)
  return {
    updated: saved.updated,
    total: MAIN_INDICES.length,
    startYmd,
    endYmd,
    errors: errors.length ? errors : undefined,
  }
}
async function fetchDividendPlanRows(token, tsCode) {
  return callTushare(token, 'dividend', { ts_code: tsCode }, 'ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,imp_ann_date')
}

async function refreshDividendPlansFromTushare(localDb, env, rawStockCode) {
  const token = String(env.TUSHARE_TOKEN || process.env.TUSHARE_TOKEN || '').trim()
  if (!token) throw new Error('TUSHARE_TOKEN not set')
  const stockCode = normalizeStockCode6(rawStockCode)
  const tsCode = toTsCode(stockCode)
  const rows = await fetchDividendPlanRows(token, tsCode)
  const saved = localDb.replaceDividendPlans(stockCode, rows)
  return { ...saved, plans: localDb.listDividendPlans(stockCode, { page: 1, pageSize: 5 }) }
}
async function refreshDividendStockFromTushare(localDb, env, rawStockCode) {
  const token = String(env.TUSHARE_TOKEN || process.env.TUSHARE_TOKEN || '').trim()
  if (!token) throw new Error('TUSHARE_TOKEN not set')

  const stockCode = normalizeStockCode6(rawStockCode)
  if (!stockCode || stockCode.length < 6) throw new Error('缂哄皯鏈夋晥鐨?stock_code')

  const tsCode = toTsCode(stockCode)
  const record = localDb.getDividendRecord(stockCode)
  const activeHolding = localDb.listHoldings().find(row => row.stock_code === stockCode)
  const stockName = record?.stock_name || activeHolding?.stock_name || ''

  let dailyRow = null
  let usedYmd = ''
  const now = Date.now()
  for (let dayBack = 0; dayBack < MAX_DAY_LOOKBACK; dayBack += 1) {
    const ymd = chinaYmdForUtcMillis(now - dayBack * 24 * 60 * 60 * 1000)
    const row = await fetchDailyOneDay(token, tsCode, ymd)
    if (row) {
      dailyRow = row
      usedYmd = ymd
      break
    }
  }
  if (!dailyRow || !usedYmd) {
    throw new Error(`鏈€杩?${MAX_DAY_LOOKBACK} 涓嚜鐒舵棩鍐呮湭鍙栧埌鏃ョ嚎琛屾儏`)
  }

  const close = Number(dailyRow.close)
  const pctChg = Number(dailyRow.pct_chg)
  let totalShares = null
  try {
    const basic = await fetchDailyBasicOneDay(token, tsCode, usedYmd)
    totalShares = wanGuToYiGu(basic?.total_share)
  } catch (error) {
    console.warn('[refresh-dividend-stock] daily_basic:', error.message || String(error))
  }

  const saved = localDb.applyDividendStockRefresh({
    stock_code: stockCode,
    stock_name: stockName,
    trade_date: usedYmd,
    close_price: close,
    daily_change_rate: Number.isFinite(pctChg) ? pctChg : 0,
    total_shares: totalShares,
  })


  let yearlyPricesUpdated = 0
  let yearlyPricesWarning = null
  try {
    const prices = await refreshYearlyPrices({
      records: record?.yearly_dividends ?? [],
      tsCode, tradeDate: usedYmd, currentClose: close,
      request: (api, params, fields) => callTushare(token, api, params, fields),
    })
    if (prices.length) yearlyPricesUpdated = localDb.updateYearlyPrices(stockCode, prices).updated
  } catch (error) {
    yearlyPricesWarning = error.message || String(error)
  }

  let bondYieldRefresh = null
  let bondYieldWarning = null
  try {
    bondYieldRefresh = await refreshChina10yBondYields(localDb)
  } catch (error) {
    bondYieldWarning = error.message || String(error)
  }

  let dividendPlans = null
  let dividendPlanWarning = null
  try {
    dividendPlans = await refreshDividendPlansFromTushare(localDb, env, stockCode)
  } catch (error) {
    dividendPlanWarning = error.message || String(error)
  }

  const warnings = [
    ...(yearlyPricesWarning ? [`年度前复权高低价更新失败：${yearlyPricesWarning}`] : []),
    ...(dividendPlanWarning ? [`dividend: ${dividendPlanWarning}`] : []),
    ...(bondYieldWarning ? [`10年国债收益率: ${bondYieldWarning}`] : []),
  ]
  return {
    ...saved,
    yearly_prices_updated: yearlyPricesUpdated,
    yearly_prices_warning: yearlyPricesWarning,
    dividend_plans_updated: dividendPlans?.updated ?? 0,
    bond_yields_updated: bondYieldRefresh?.updated ?? 0,
    bond_yield_latest_trade_date: bondYieldRefresh?.latest_trade_date ?? null,
    hint: totalShares == null ? 'daily_basic did not return total_share.' : undefined,
    warnings: warnings.length ? warnings : undefined,
  }
}
export function localApiPlugin(env = {}) {
  const localDb = getDefaultLocalDatabase({ env })

  return {
    name: 'local-sqlite-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? ''
        const method = req.method ?? 'GET'

        try {
          if (pathname === '/api/holdings' && method === 'GET') {
            sendJson(res, 200, localDb.listHoldings())
            return
          }

          if (pathname === '/api/dividend-stocks' && method === 'GET') {
            sendJson(res, 200, localDb.listDividendStocks())
            return
          }

          if (pathname === '/api/watchlist' && method === 'GET') {
            sendJson(res, 200, localDb.listWatchlist())
            return
          }

          if (pathname === '/api/holdings' && method === 'POST') {
            const body = await readJson(req)
            sendJson(res, 200, localDb.createHolding(body))
            return
          }

          if (pathname === '/api/available-cash' && method === 'GET') {
            sendJson(res, 200, localDb.getAvailableCash())
            return
          }
          if (pathname === '/api/available-cash' && method === 'PATCH') {
            const body = await readJson(req)
            try { sendJson(res, 200, localDb.updateAvailableCash(body)) }
            catch (error) { sendJson(res, 400, { error: error.message }) }
            return
          }
          if (pathname === '/api/annual-dividend-income' && method === 'GET') {
            const url = new URL(req.url, 'http://localhost')
            const year = Number(url.searchParams.get('year') || new Date().getFullYear())
            sendJson(res, 200, localDb.getAnnualDividendIncomeSummary(year))
            return
          }

          if (pathname === '/api/annual-dividend-income' && method === 'PATCH') {
            const body = await readJson(req)
            sendJson(res, 200, localDb.updateAnnualDividendIncome(body))
            return
          }
          if (pathname === '/api/portfolio-targets' && method === 'GET') {
            sendJson(res, 200, localDb.listPortfolioTargets())
            return
          }

          if (pathname === '/api/portfolio-targets' && method === 'PATCH') {
            const body = await readJson(req)
            sendJson(res, 200, localDb.updatePortfolioTargets(body.targets ?? body))
            return
          }

          const holdingMatch = pathname.match(/^\/api\/holdings\/(\d+)$/)
          if (holdingMatch && method === 'PATCH') {
            const body = await readJson(req)
            sendJson(res, 200, localDb.updateHolding(Number(holdingMatch[1]), body))
            return
          }

          if (holdingMatch && method === 'DELETE') {
            localDb.deleteHolding(Number(holdingMatch[1]))
            sendJson(res, 200, { ok: true })
            return
          }

          const holdingCodeDeleteMatch = pathname.match(/^\/api\/holdings\/by-stock\/([^/]+)$/)
          if (holdingCodeDeleteMatch && method === 'DELETE') {
            const deleted = localDb.softDeleteHoldingByStockCode(decodeURIComponent(holdingCodeDeleteMatch[1]))
            sendJson(res, 200, { deleted })
            return
          }

          if (pathname === '/api/market-data' && method === 'GET') {
            sendJson(res, 200, localDb.listMarketData())
            return
          }
          if (pathname === '/api/browser-records/migrate' && method === 'POST') {
            const body = await readJson(req)
            try { sendJson(res, 200, migrateBrowserRecords(localDb, body.entries)) }
            catch (error) { sendJson(res, 400, { error: error.message }) }
            return
          }
          if (pathname === '/api/dividend-selection' && method === 'GET') {
            sendJson(res, 200, { selectedCode: getDividendSelection(localDb) })
            return
          }
          if (pathname === '/api/dividend-selection' && method === 'PATCH') {
            const body = await readJson(req)
            sendJson(res, 200, saveDividendSelection(localDb, body.selectedCode))
            return
          }
          const journalMatch = pathname.match(/^\/api\/journal\/([^/]+)$/)
          if (journalMatch && method === 'GET') {
            sendJson(res, 200, listJournalEntries(localDb, decodeURIComponent(journalMatch[1])))
            return
          }
          if (journalMatch && method === 'POST') {
            const body = await readJson(req)
            try { sendJson(res, 200, saveJournalEntry(localDb, decodeURIComponent(journalMatch[1]), body)) }
            catch (error) { sendJson(res, 400, { error: error.message }) }
            return
          }
          const journalEntryMatch = pathname.match(/^\/api\/journal\/([^/]+)\/(\d+)$/)
          if (journalEntryMatch && method === 'PATCH') {
            const body = await readJson(req)
            try { sendJson(res, 200, saveJournalEntry(localDb, decodeURIComponent(journalEntryMatch[1]), body, Number(journalEntryMatch[2]))) }
            catch (error) { sendJson(res, 400, { error: error.message }) }
            return
          }
          const stockDetailMatch = pathname.match(/^\/api\/stock-detail\/([^/]+)$/)
          if (stockDetailMatch && method === 'GET') {
            sendJson(res, 200, localDb.getStockDetail(decodeURIComponent(stockDetailMatch[1])))
            return
          }

          const stockDetailRefreshMatch = pathname.match(/^\/api\/stock-detail\/([^/]+)\/refresh$/)
          if (stockDetailRefreshMatch && method === 'POST') {
            const data = await refreshStockDetailFromSources(localDb, env, decodeURIComponent(stockDetailRefreshMatch[1]))
            sendJson(res, 200, data)
            return
          }


          if (pathname === '/api/refresh-market-data' && method === 'POST') {
            sendJson(res, 200, localDb.refreshMarketData())
            return
          }

          if (pathname === '/api/expected-dividend-yield-rankings' && method === 'GET') {
            sendJson(res, 200, localDb.listExpectedDividendYieldRankings(5))
            return
          }

          if (pathname === '/api/expected-dividend-yield-rankings/refresh' && method === 'POST') {
            const candidates = localDb.listExpectedDividendYieldRefreshCandidates()
            const results = []
            const errors = []
            let bondYieldRefresh = null
            try {
              bondYieldRefresh = await refreshChina10yBondYields(localDb)
            } catch (error) {
              errors.push(`10年国债收益率: ${error.message || String(error)}`)
            }
            for (const candidate of candidates) {
              try {
                const data = await refreshDividendStockFromTushare(localDb, env, candidate.stock_code)
                results.push(data)
              } catch (error) {
                errors.push(`${candidate.stock_name || candidate.stock_code}: ${error.message || String(error)}`)
              }
            }
            sendJson(res, 200, {
              ok: errors.length === 0,
              total: candidates.length,
              updated: results.length,
              bond_yields_updated: bondYieldRefresh?.updated ?? 0,
              bond_yield_latest_trade_date: bondYieldRefresh?.latest_trade_date ?? null,
              errors: errors.length ? errors : undefined,
            })
            return
          }
          const dividendPlansMatch = pathname.match(/^\/api\/dividend-records\/([^/]+)\/plans$/)
          if (dividendPlansMatch && method === 'GET') {
            const url = new URL(req.url, 'http://localhost')
            const page = Number(url.searchParams.get('page') || 1)
            const pageSize = Number(url.searchParams.get('pageSize') || 5)
            sendJson(res, 200, localDb.listDividendPlans(decodeURIComponent(dividendPlansMatch[1]), { page, pageSize }))
            return
          }
          const dividendMatch = pathname.match(/^\/api\/dividend-records\/([^/]+)$/)
          if (dividendMatch && method === 'GET') {
            sendJson(res, 200, localDb.getDividendRecord(decodeURIComponent(dividendMatch[1])))
            return
          }

          const valuationMatch = pathname.match(/^\/api\/dividend-records\/([^/]+)\/valuation$/)
          if (valuationMatch && method === 'PATCH') {
            const body = await readJson(req)
            localDb.updateDividendValuation(decodeURIComponent(valuationMatch[1]), body)
            sendJson(res, 200, { ok: true })
            return
          }

          if (pathname === '/api/refresh-dividend-stock' && method === 'POST') {
            const body = await readJson(req)
            const data = await refreshDividendStockFromTushare(localDb, env, body.stock_code)
            sendJson(res, 200, data)
            return
          }

          if (pathname === '/api/market-index-snapshots' && method === 'GET') {
            sendJson(res, 200, localDb.listMarketIndexSnapshots())
            return
          }

          if (pathname === '/api/refresh-index-daily' && method === 'POST') {
            const data = await refreshMarketIndicesFromTushare(localDb, env)
            sendJson(res, 200, data)
            return
          }

          if (pathname === '/api/market-sw-l3-daily' && method === 'GET') {
            sendJson(res, 200, localDb.listMarketSwL3Daily())
            return
          }

          if (pathname === '/api/refresh-sw-l3-daily' && method === 'POST') {
            sendJson(res, 200, {
              disabled: true,
              updated: 0,
              message: '申万三级刷新已停用。',
            })
            return
          }

          if (pathname === '/api/dividend/add-stock' && method === 'POST') {
            const body = await readJson(req)
            const query = String(body.query ?? '').trim()
            if (!query) {
              sendJson(res, 400, { ok: false, error: 'query 不能为空' })
              return
            }
            const runner = path.join(root, 'scripts', 'run-dividend-add-stock.mjs')
            const result = await runNodeScript(runner, [query], env)
            const parsed = parseLastJson(result.stdout)
            if (!parsed) {
              sendJson(res, 500, {
                ok: false,
                error: `鏈В鏋愬埌 JSON 缁撴灉銆俥xit=${result.code}\nstderr:\n${result.stderr.slice(-6000)}\nstdout:\n${result.stdout.slice(-4000)}`,
              })
              return
            }
            sendJson(res, parsed.ok ? 200 : 400, parsed)
            return
          }
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message || String(error) })
          return
        }

        next()
      })
    },
  }
}
