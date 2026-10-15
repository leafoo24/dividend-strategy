import { useState, useEffect, useRef } from 'react'
import { calculateYieldRange, summarizeHistoricalDividends } from '@/lib/dividendMetrics'
import { ChevronDown, RefreshCw, Plus, Trash2, Search, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/toast'
import { cn, fmtPrice, changeClass } from '@/lib/utils'
import { softDeleteHoldingByStockCode } from '@/services/holdings'
import { fetchDividendStocks } from '@/services/watchlist'
import { fetchDividendRecord, refreshDividendStock, saveDividendValuationToSupabase } from '@/services/dividendRecords'
import { fetchMarketDataMap } from '@/services/marketData'
import { fetchDividendPlans } from '@/services/dividendPlans'
import { addDividendStock } from '@/services/addDividendStock'
import { fetchDividendSelection, saveDividendSelection } from '@/services/browserMigration'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// 小型内联数字输入框
function NumInput({ value, onChange, onBlur, suffix = '', className }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        className={cn(
          'w-16 text-right bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-xs num focus:outline-none focus:ring-1 focus:ring-amber-400',
          className
        )}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </span>
  )
}

const VALUATION_ROWS_DEFAULT = [
  { yield: 4.5, label: '高估' },
  { yield: 5.0, label: '合理' },
  { yield: 7.0, label: '低估' },
]

function parseValuationTargets(raw) {
  if (!raw) return null
  const arr = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!Array.isArray(arr) || !arr.length) return null
  const mapped = arr.map(r => ({
    yield: Number(r?.yield),
    label: typeof r?.label === 'string' ? r.label : '',
  }))
  return mapped.every(r => Number.isFinite(r.yield)) ? mapped : null
}

function getStockDefaults(code, d) {
  const fromDbRows = parseValuationTargets(d?.valuation_targets)
  const payoutFromDb =
    d?.expected_payout_ratio != null && Number.isFinite(Number(d.expected_payout_ratio))
      ? String(d.expected_payout_ratio)
      : null
  return {
    estPayoutRatio: payoutFromDb ?? '35',
    estNetProfit:   d?.expected_net_profit != null ? String(d.expected_net_profit) : '',
    /** 总股本来自库（daily_basic 刷新），不由本地编辑覆盖 */
    estTotalShares: d?.total_shares != null ? String(d.total_shares) : '',
    valuationRows:  fromDbRows ?? VALUATION_ROWS_DEFAULT,
  }
}

export default function DividendAnalysisPage({ pageActive = true }) {
  const toast = useToast()

  const [holdings,       setHoldings]       = useState([])
  const [marketDataMap,  setMarketDataMap]  = useState({})
  const [selectedCode,   setSelectedCode]   = useState('')
  const [selectionReady, setSelectionReady] = useState(false)
  const [dropdownOpen,   setDropdownOpen]   = useState(false)
  const [stockSearch, setStockSearch] = useState('')
  const [uiState,        setUiState]        = useState('idle')
  const [data,           setData]           = useState(null)
  const [mdData,         setMdData]         = useState(null)
  const [estPayoutRatio, setEstPayoutRatio] = useState('35')
  const [estNetProfit,   setEstNetProfit]   = useState('')
  const [estTotalShares, setEstTotalShares] = useState('')
  const [valuationRows,  setValuationRows]  = useState(VALUATION_ROWS_DEFAULT)
  const [addOpen,        setAddOpen]        = useState(false)
  const [addQuery,       setAddQuery]       = useState('')
  const [addBusy,       setAddBusy]       = useState(false)
  const [deleteOpen,    setDeleteOpen]     = useState(false)
  const [deleteTarget,  setDeleteTarget]   = useState(null)
  const [deleteBusy,    setDeleteBusy]     = useState(false)
  const [refreshBusy,   setRefreshBusy]    = useState(false)
  const [planPage,      setPlanPage]       = useState(1)
  const [plansData,     setPlansData]      = useState({ rows: [], total: 0, page: 1, pageSize: 5 })

  function getCurrentPrice() {
    return [mdData?.close_price, data?.current_price, holdings.find(h => h.stock_code === selectedCode)?.last_close_price].map(Number).find(price => Number.isFinite(price) && price > 0) ?? 0
  }

  function getCurrentYield() {
    const price = getCurrentPrice()
    const dps = getExpectedDps()
    if (price > 0 && dps > 0) return dps / price * 100
    return !dirtyRef.current && data?.expected_dividend_yield != null ? Number(data.expected_dividend_yield) : null
  }

  const dirtyRef = useRef(false)
  const wasPageActive = useRef(false)
  const autoSaveTimerRef = useRef(null)
  const saveQueueRef = useRef(Promise.resolve())

  function queueValuationSave(code, payload) {
    const request = saveQueueRef.current.catch(() => {}).then(() => saveDividendValuationToSupabase(code, payload))
    saveQueueRef.current = request
    return request
  }

  function saveFinishedInput() {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    const p = persistRef.current
    if (p.uiState !== 'loaded' || !p.selectedCode || !dirtyRef.current) return
    queueValuationSave(p.selectedCode, {
      expected_net_profit: p.estNetProfit,
      total_shares: p.estTotalShares,
      expected_payout_ratio: p.estPayoutRatio,
      current_price: p.currentPrice,
      expected_dividend_yield: p.currentYield,
      valuation_targets: p.valuationRows,
    }).catch(err => toast({ title: '保存到数据库失败：' + err.message, variant: 'destructive' }))
  }
  const persistRef = useRef({
    selectedCode: '',
    uiState: 'idle',
    estPayoutRatio: '35',
    estNetProfit: '',
    estTotalShares: '',
    valuationRows: VALUATION_ROWS_DEFAULT,
    currentPrice: 0,
    currentYield: null,
  })
  persistRef.current = {
    selectedCode,
    uiState,
    estPayoutRatio,
    estNetProfit,
    estTotalShares,
    valuationRows,
    currentPrice: getCurrentPrice(),
    currentYield: getCurrentYield(),
  }

  useEffect(() => {
    if (wasPageActive.current && !pageActive) {
      const p = persistRef.current
      if (p.uiState === 'loaded' && p.selectedCode && dirtyRef.current) {
        queueValuationSave(p.selectedCode, {
          expected_net_profit: p.estNetProfit,
          total_shares: p.estTotalShares,
          expected_payout_ratio: p.estPayoutRatio,
          current_price: p.currentPrice,
          expected_dividend_yield: p.currentYield,
          valuation_targets: p.valuationRows,
        }).catch(err =>
          toast({ title: '保存到数据库失败：' + err.message, variant: 'destructive' }),
        )
      }
    }
    wasPageActive.current = pageActive
  }, [pageActive])

  // 加载持仓列表和行情
  useEffect(() => {
    Promise.all([fetchDividendStocks(), fetchMarketDataMap(), fetchDividendSelection()])
      .then(([h, md, preference]) => { setHoldings(h); setMarketDataMap(md); setSelectedCode(preference.selectedCode || ''); setSelectionReady(true) })
      .catch(e => toast({ title: '加载数据失败：' + e.message, variant: 'destructive' }))
  }, [])

  // 初次加载：若有上次选中的股票，自动加载其数据
  // Load the previously selected stock after holdings arrive
  useEffect(() => {
    if (selectionReady && selectedCode && holdings.length > 0) {
      const h = holdings.find(h => h.stock_code === selectedCode)
      if (h) loadDividendData(h, false)
    }
  }, [selectionReady, holdings])

  useEffect(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    if (uiState !== 'loaded' || !selectedCode || !dirtyRef.current) return undefined

    const payload = {
      expected_net_profit: estNetProfit,
      total_shares: estTotalShares,
      expected_payout_ratio: estPayoutRatio,
      current_price: getCurrentPrice(),
      expected_dividend_yield: getCurrentYield(),
      valuation_targets: valuationRows,
    }
    autoSaveTimerRef.current = setTimeout(() => {
      queueValuationSave(selectedCode, payload).catch(err =>
        toast({ title: '保存到数据库失败：' + err.message, variant: 'destructive' }),
      )
    }, 600)

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [selectedCode, uiState, estPayoutRatio, estNetProfit, estTotalShares, valuationRows, mdData, data])

  async function loadDividendData(holding, closeDropdown = true) {
    if (closeDropdown) setDropdownOpen(false)
    const code = holding.stock_code
    const p = persistRef.current
    if (p.selectedCode && p.selectedCode !== code && p.uiState === 'loaded' && dirtyRef.current) {
      try {
        await queueValuationSave(p.selectedCode, {
          expected_net_profit: p.estNetProfit,
          total_shares: p.estTotalShares,
          expected_payout_ratio: p.estPayoutRatio,
          current_price: p.currentPrice,
          expected_dividend_yield: p.currentYield,
          valuation_targets: p.valuationRows,
        })
      } catch (err) {
        toast({ title: '切换股票前保存失败：' + err.message, variant: 'destructive' })
      }
    }
    void saveDividendSelection(code).catch(err => toast({ title: '保存所选股票失败：' + err.message, variant: 'destructive' }))
    setSelectedCode(code)
    dirtyRef.current = false
    setUiState('loading')
    try {
      const d    = await fetchDividendRecord(code)
      const defs = getStockDefaults(code, d)
      setData(d)
      setMdData(marketDataMap[code] ?? null)
      setEstPayoutRatio(defs.estPayoutRatio)
      setEstNetProfit(defs.estNetProfit)
      setEstTotalShares(defs.estTotalShares)
      setValuationRows(defs.valuationRows)
      setPlanPage(1)
      setPlansData(await fetchDividendPlans(code, { page: 1, pageSize: 5 }))
      setUiState('loaded')
    } catch (e) {
      setUiState('error')
      toast({ title: `加载 ${holding.stock_name} 数据失败：` + e.message, variant: 'destructive' })
    }
  }

  async function submitAddStock() {
    const q = addQuery.trim()
    if (!q) return
    setAddBusy(true)
    try {
      const r = await addDividendStock(q)
      const [h, md] = await Promise.all([fetchDividendStocks(), fetchMarketDataMap()])
      setMarketDataMap(md)
      let list = h
      if (!list.some(x => x.stock_code === r.stock_code)) {
        list = [
          ...list,
          {
            id: `watch-${r.stock_code}`,
            stock_code: r.stock_code,
            stock_name: r.stock_name,
            status: 'active',
          },
        ]
      }
      setHoldings(list)
      setAddOpen(false)
      setAddQuery('')
      const holding = list.find(x => x.stock_code === r.stock_code)
      if (holding) await loadDividendData(holding, false)
      toast({
        title:
          `已添加 ${r.stock_name}（${r.stock_code}）` + (r.warn ? ` · ${r.warn}` : ''),
      })
    } catch (e) {
      toast({ title: e.message || String(e), variant: 'destructive' })
    } finally {
      setAddBusy(false)
    }
  }

  async function handleRefreshStock() {
    if (!selectedCode || uiState !== 'loaded') return
    setRefreshBusy(true)
    try {
      const r = await refreshDividendStock(selectedCode)
      const [mdMap, rec] = await Promise.all([fetchMarketDataMap(), fetchDividendRecord(selectedCode)])
      setMarketDataMap(mdMap)
      setMdData(mdMap[selectedCode] ?? null)
      setData(rec)
      if (rec?.total_shares != null) setEstTotalShares(String(rec.total_shares))
      setPlanPage(1)
      setPlansData(await fetchDividendPlans(selectedCode, { page: 1, pageSize: 5 }))
      const hint = r?.hint ? ` · ${r.hint}` : ''
      const priceMessage = r?.yearly_prices_warning ? ' · 年度高低价更新失败，保留原数据' : r?.yearly_prices_updated > 0 ? ' · 前复权年度高低价已更新' : ''
      const warnings = r?.warnings?.length ? ' · ' + r.warnings.join('；') : ''
      toast({ title: `行情已刷新${priceMessage}${hint}${warnings}`, variant: r?.yearly_prices_warning ? 'destructive' : undefined })
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), variant: 'destructive' })
    } finally {
      setRefreshBusy(false)
    }
  }

  async function submitRemoveStock(holding) {
    if (!holding?.stock_code) return
    const code = holding.stock_code
    setDeleteBusy(true)
    try {
      const p = persistRef.current
      if (p.selectedCode === code && p.uiState === 'loaded' && dirtyRef.current) {
        await queueValuationSave(code, {
          expected_net_profit: p.estNetProfit,
          total_shares: p.estTotalShares,
          expected_payout_ratio: p.estPayoutRatio,
          current_price: p.currentPrice,
          expected_dividend_yield: p.currentYield,
          valuation_targets: p.valuationRows,
        })
      }
      await softDeleteHoldingByStockCode(code)
      const remaining = holdings.filter(h => h.stock_code !== code && h.status === 'active')
      setHoldings(remaining)
      setDeleteOpen(false)
      setDeleteTarget(null)
      setDropdownOpen(false)
      if (selectedCode === code) {
        if (remaining.length > 0) {
          const nh = remaining[0]
          await loadDividendData(nh, false)
        } else {
          void saveDividendSelection('').catch(err => toast({ title: '保存所选股票失败：' + err.message, variant: 'destructive' }))
          setSelectedCode('')
          setUiState('idle')
          setData(null)
          setMdData(null)
        }
      }
      toast({ title: `已移除 ${holding.stock_name}（${code}）` })
    } catch (e) {
      toast({ title: e.message || String(e), variant: 'destructive' })
    } finally {
      setDeleteBusy(false)
    }
  }

  const activeHoldings   = holdings.filter(h => h.status === 'active')
  const selectedHolding  = activeHoldings.find(h => h.stock_code === selectedCode)
  const stockSearchTerm = stockSearch.trim().toLocaleLowerCase()
  const filteredHoldings = activeHoldings.filter(h => (h.stock_name ?? '').toLocaleLowerCase().includes(stockSearchTerm))

  // 预期每股分红 = 预期分红总额 / 总股本 = 净利润 × 分红率 / 总股本
  function getExpectedDps() {
    const shares = Number(estTotalShares)
    if (shares > 0 && estNetProfit && estPayoutRatio
        && !isNaN(Number(estNetProfit)) && !isNaN(Number(estPayoutRatio))) {
      return Number(estNetProfit) * Number(estPayoutRatio) / 100 / shares
    }
    return 0
  }

  // 估值判断颜色与图标
  function valuationStyle(label) {
    if (label === '低估') return { badge: 'success', rowCls: 'bg-emerald-50' }
    if (label === '合理') return { badge: 'warning', rowCls: 'bg-amber-50' }
    return { badge: 'danger', rowCls: 'bg-red-50' }
  }

  const sorted = data ? data.yearly_dividends.map(row => ({
    ...row,
    ...calculateYieldRange(row.dividend_per_share, row.year_high_price, row.year_low_price),
  })).sort((a, b) => a.year - b.year) : []
  /** 最后一列为「预期年」{year}E（每股分红+分红率可编辑），不再单独增加 lastYear+1 列（如 2027E） */
  const histYears = sorted.length > 1 ? sorted.slice(0, -1) : []
  const forecastYearRow = sorted.length ? sorted[sorted.length - 1] : null
  const forecastYearLabel = forecastYearRow ? `${forecastYearRow.year}E` : `${new Date().getFullYear()}E`
  const currentPrice = getCurrentPrice()
  const totalPlanPages = Math.max(1, Math.ceil((plansData.total ?? 0) / (plansData.pageSize ?? 5)))

  async function loadDividendPlansPage(nextPage) {
    if (!selectedCode) return
    const safePage = Math.max(1, Math.min(totalPlanPages, nextPage))
    const result = await fetchDividendPlans(selectedCode, { page: safePage, pageSize: 5 })
    setPlanPage(result.page)
    setPlansData(result)
  }

  const expectedDps = getExpectedDps()
  const currentYield = getCurrentYield()
  /** 与 sync CSV 一致：最高股息率=预期每股分红/年内最低×100，最低=预期每股分红/年内最高×100（依赖用户填写的分红率等基本面） */
  const fyLow = forecastYearRow?.year_low_price != null ? Number(forecastYearRow.year_low_price) : null
  const fyHigh = forecastYearRow?.year_high_price != null ? Number(forecastYearRow.year_high_price) : null
  const forecastRange = calculateYieldRange(expectedDps > 0 ? expectedDps : null, fyHigh, fyLow)
  const forecastMaxDividendYield = forecastRange.max_dividend_yield
  const forecastMinDividendYield = forecastRange.min_dividend_yield
  const forecastYieldSpread = forecastRange.spread

  // Historical summaries use the same derived rows as the table, excluding the forecast column.
  const { maxYield: histMaxYield, minPrice: histMinPrice, maxSpread: histMaxSpread } = summarizeHistoricalDividends(histYears)

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">股息估值分析</h1>
          <p className="text-xs text-muted-foreground mt-0.5">黄色单元格可手动调整</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {selectedHolding && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/40 hover:bg-destructive/10"
              onClick={() => {
                setDeleteTarget(selectedHolding)
                setDeleteOpen(true)
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              移除当前
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            新增个股
          </Button>
        </div>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增个股</DialogTitle>
            <DialogDescription>
              输入 6 位代码（如 600900）、带交易所后缀代码，或股票简称。确认后将拉取 Tushare 数据写入 CSV 并同步到 Supabase（需本地 npm run dev 且已配置环境变量）。
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="例如：600900 或 长江电力"
            value={addQuery}
            onChange={e => setAddQuery(e.target.value)}
            disabled={addBusy}
            onKeyDown={e => e.key === 'Enter' && !addBusy && submitAddStock()}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" disabled={addBusy} onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button type="button" size="sm" disabled={addBusy || !addQuery.trim()} onClick={() => void submitAddStock()}>
              {addBusy ? '处理中…' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={o => {
          if (deleteBusy) return
          setDeleteOpen(o)
          if (!o) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除个股</DialogTitle>
            <DialogDescription>
              将「{deleteTarget?.stock_name}（{deleteTarget?.stock_code}）」从本页列表中移除：数据库中对应持仓会标记为已删除；股息记录与年度分红表中的历史数据不会自动删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" disabled={deleteBusy} onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleteBusy || !deleteTarget}
              onClick={() => void submitRemoveStock(deleteTarget)}
            >
              {deleteBusy ? '处理中…' : '确认移除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stock selector + 刷新行情/总股本 */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="relative w-72">
          <button
            type="button"
            onClick={() => { setStockSearch(''); setDropdownOpen(v => !v) }}
            aria-expanded={dropdownOpen}
            aria-controls="dividend-stock-options"
            className="flex items-center justify-between w-full h-8 px-3 rounded-md border border-border bg-card text-sm text-foreground hover:border-primary/50 transition-colors"
          >
            {selectedHolding
              ? <span>{selectedHolding.stock_name} <span className="text-muted-foreground num ml-1 text-xs">{selectedHolding.stock_code}</span></span>
              : <span className="text-muted-foreground">选择持仓股票…</span>}
            <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform shrink-0', dropdownOpen && 'rotate-180')} />
          </button>
        {dropdownOpen && (
          <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setDropdownOpen(false)
                event.currentTarget.parentElement.querySelector('button')?.focus()
              }
            }}>
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input autoFocus value={stockSearch}
                  onChange={event => setStockSearch(event.target.value)}
                  aria-label="按标的名称搜索" placeholder="搜索标的名称…"
                  className="h-8 pl-8 pr-8 text-xs" />
                {stockSearch && <button type="button" aria-label="清空搜索"
                  onClick={event => { setStockSearch(''); event.currentTarget.parentElement.querySelector('input')?.focus() }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted">
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>}
              </div>
            </div>
            <div id="dividend-stock-options" className="max-h-64 overflow-y-auto">
              {filteredHoldings.length === 0 && <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
                {stockSearchTerm ? '未找到匹配的标的' : '暂无标的，请先添加'}
              </p>}
              {filteredHoldings.map(h => (
                <div
                  key={h.id}
                  className={cn(
                    'flex items-stretch border-b border-border last:border-b-0',
                    selectedCode === h.stock_code && 'bg-primary/10',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => loadDividendData(h)}
                    className={cn(
                      'flex-1 min-w-0 px-3 py-2 text-sm text-left hover:bg-muted/80 transition-colors',
                      selectedCode === h.stock_code && 'text-primary',
                    )}
                  >
                    <span className="truncate block">
                      {h.stock_name}{' '}
                      <span className="text-muted-foreground num text-xs ml-1">{h.stock_code}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    title="移除此股票"
                    className="shrink-0 px-2.5 py-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    onClick={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      setDeleteTarget(h)
                      setDeleteOpen(true)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
        {uiState === 'loaded' && selectedCode && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={refreshBusy}
            onClick={() => void handleRefreshStock()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', refreshBusy && 'animate-spin')} />
            刷新
          </Button>
        )}
      </div>

      {uiState === 'loaded' && data && (
        <div className="space-y-5">

          {/* ── 历史分红表（转置：指标为行，年份为列）── */}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-3 py-2 text-left text-muted-foreground font-medium w-28">指标</th>
                  {histYears.map(d => (
                    <th key={d.year} className="px-3 py-2 text-right text-muted-foreground font-medium">{d.year}</th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium text-amber-600 bg-amber-50/60 border-l border-amber-200">
                    {forecastYearLabel}
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* 每股分红 */}
                <tr className="border-b border-border">
                  <td className="px-3 py-2 text-muted-foreground">每股分红（元）</td>
                  {histYears.map(d => (
                    <td key={d.year} className="px-3 py-2 text-right num font-medium text-primary">
                      {d.dividend_per_share != null ? Number(d.dividend_per_share).toFixed(3) : '—'}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right num font-medium text-primary bg-amber-50/60 border-l border-amber-200">
                    {expectedDps > 0 ? expectedDps.toFixed(3) : '—'}
                  </td>
                </tr>
                {/* 分红率 */}
                <tr className="border-b border-border bg-muted/20">
                  <td className="px-3 py-2 text-muted-foreground">分红率（%）</td>
                  {histYears.map(d => (
                    <td key={d.year} className="px-3 py-2 text-right num">
                      {d.payout_ratio != null ? Number(d.payout_ratio).toFixed(2) : '—'}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right bg-amber-50/60 border-l border-amber-200">
                    <NumInput value={estPayoutRatio} onChange={v => { dirtyRef.current = true; setEstPayoutRatio(v) }} onBlur={saveFinishedInput} suffix="%" />
                  </td>
                </tr>
                {/* 年内最高价 */}
                <tr className="border-b border-border">
                  <td className="px-3 py-2 text-muted-foreground">年内最高价</td>
                  {histYears.map(d => (
                    <td key={d.year} className="px-3 py-2 text-right num">{d.year_high_price != null ? d.year_high_price.toFixed(2) : '—'}</td>
                  ))}
                  <td className="px-3 py-2 text-right num bg-amber-50/60 border-l border-amber-200">
                    {forecastYearRow?.year_high_price != null ? forecastYearRow.year_high_price.toFixed(2) : '—'}
                  </td>
                </tr>
                {/* 年内最低价 */}
                <tr className="border-b border-border bg-muted/20">
                  <td className="px-3 py-2 text-muted-foreground">年内最低价</td>
                  {histYears.map(d => (
                    <td key={d.year} className="px-3 py-2 text-right num">{d.year_low_price != null ? d.year_low_price.toFixed(2) : '—'}</td>
                  ))}
                  <td className="px-3 py-2 text-right num bg-amber-50/60 border-l border-amber-200">
                    {forecastYearRow?.year_low_price != null ? forecastYearRow.year_low_price.toFixed(2) : '—'}
                  </td>
                </tr>
                {/* 最高股息率 */}
                <tr className="border-b border-border">
                  <td className="px-3 py-2 text-muted-foreground">最高股息率</td>
                  {histYears.map(d => (
                    <td key={d.year} className="px-3 py-2 text-right num rise">{d.max_dividend_yield != null ? d.max_dividend_yield.toFixed(1) + '%' : '—'}</td>
                  ))}
                  <td className="px-3 py-2 text-right num rise bg-amber-50/60 border-l border-amber-200">
                    {forecastMaxDividendYield != null ? `${forecastMaxDividendYield.toFixed(1)}%` : '—'}
                  </td>
                </tr>
                {/* 最低股息率 */}
                <tr className="border-b border-border bg-muted/20">
                  <td className="px-3 py-2 text-muted-foreground">最低股息率</td>
                  {histYears.map(d => (
                    <td key={d.year} className="px-3 py-2 text-right num text-muted-foreground">{d.min_dividend_yield != null ? d.min_dividend_yield.toFixed(1) + '%' : '—'}</td>
                  ))}
                  <td className="px-3 py-2 text-right num text-muted-foreground bg-amber-50/60 border-l border-amber-200">
                    {forecastMinDividendYield != null ? `${forecastMinDividendYield.toFixed(1)}%` : '—'}
                  </td>
                </tr>
                {/* 10年期国债收益率 */}
                <tr className="border-b border-border">
                  <td className="px-3 py-2 text-muted-foreground">10年国债收益率</td>
                  {histYears.map(d => (
                    <td key={d.year} className="px-3 py-2 text-right num text-muted-foreground">{d.bond_yield != null ? d.bond_yield.toFixed(2) + '%' : '—'}</td>
                  ))}
                  <td className="px-3 py-2 text-right num text-muted-foreground bg-amber-50/60 border-l border-amber-200">
                    {forecastYearRow?.bond_yield != null ? `${forecastYearRow.bond_yield.toFixed(2)}%` : '—'}
                  </td>
                </tr>
                {/* 息差 */}
                <tr>
                  <td className="px-3 py-2 text-muted-foreground">息差（高-低）</td>
                  {histYears.map(d => {
                    const spread = d.spread != null ? d.spread : (d.max_dividend_yield != null && d.min_dividend_yield != null ? d.max_dividend_yield - d.min_dividend_yield : null)
                    return <td key={d.year} className="px-3 py-2 text-right num text-amber-600">{spread != null ? spread.toFixed(1) + '%' : '—'}</td>
                  })}
                  <td className="px-3 py-2 text-right num text-amber-600 bg-amber-50/60 border-l border-amber-200">
                    {forecastYieldSpread != null ? `${forecastYieldSpread.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* ── 下方两栏 ── */}
          <div className="grid grid-cols-2 gap-4">

            {/* 左：基本面预期 */}
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <p className="text-xs font-medium text-foreground mb-2">基本面预期</p>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">预期归母净利润（亿元）</span>
                  <NumInput value={estNetProfit} onChange={v => { dirtyRef.current = true; setEstNetProfit(v) }} onBlur={saveFinishedInput} className="w-20" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">预期分红总额（亿元）</span>
                  <span className="num font-medium">
                    {estNetProfit && estPayoutRatio && !isNaN(Number(estNetProfit))
                      ? (Number(estNetProfit) * Number(estPayoutRatio) / 100).toFixed(2)
                      : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">总股本（亿股）</span>
                  <span className="num font-medium text-right min-w-[5rem]" title="来自 Tushare daily_basic，请点击右上角「刷新」更新">
                    {estTotalShares !== '' && !Number.isNaN(Number(estTotalShares))
                      ? Number(estTotalShares).toLocaleString(undefined, { maximumFractionDigits: 4 })
                      : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-2 mt-2">
                  <span className="text-muted-foreground">预期每股分红（元）</span>
                  <span className="num font-semibold text-primary">{expectedDps > 0 ? expectedDps.toFixed(3) : '—'}</span>
                </div>
              </div>

              {/* 历史统计 */}
              <div className="border-t border-border pt-3 mt-1 space-y-1.5 text-xs">
                <p className="text-xs font-medium text-foreground mb-1.5">近年历史统计</p>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">历史最高股息率</span>
                  <span className="num rise font-medium">{histMaxYield != null ? histMaxYield.toFixed(1) + '%' : '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">历史最低价格</span>
                  <span className="num font-medium">{histMinPrice != null ? '¥' + histMinPrice.toFixed(2) : '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">最大息差（历年）</span>
                  <span className="num text-amber-600 font-medium">
                    {histMaxSpread != null ? histMaxSpread.toFixed(1) + '%' : '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* 右：估值区间 */}
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-foreground">估值区间</p>
                {currentPrice > 0 && (
                  <div className="text-xs text-right">
                    <span className="text-muted-foreground">当前股价 </span>
                    <span className="num font-semibold">¥{fmtPrice(currentPrice)}</span>
                    {currentYield != null && <>
                      <span className="text-muted-foreground ml-2">预期股息率 </span>
                      <span className="num font-semibold text-primary">{currentYield.toFixed(1)}%</span>
                    </>}
                  </div>
                )}
              </div>

              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pb-2 text-left text-muted-foreground font-medium">目标股息率</th>
                    <th className="pb-2 text-right text-muted-foreground font-medium">对应股价</th>
                    <th className="pb-2 text-right text-muted-foreground font-medium">判断</th>
                    <th className="pb-2 text-right text-muted-foreground font-medium">与当前价差</th>
                  </tr>
                </thead>
                <tbody>
                  {valuationRows.map((row, i) => {
                    const targetPrice = expectedDps > 0 && row.yield > 0 ? expectedDps / (row.yield / 100) : 0
                    /** 当前价涨至/跌至对应股价时的涨跌幅：(对应股价 − 当前价) / 当前价 */
                    const diff =
                      currentPrice > 0 && targetPrice > 0
                        ? ((targetPrice - currentPrice) / currentPrice) * 100
                        : null
                    const { badge, rowCls } = valuationStyle(row.label)
                    return (
                      <tr key={i} className={cn('border-b border-border last:border-0', rowCls)}>
                        <td className="py-2 pr-2">
                          <NumInput
                            value={row.yield}
                            onBlur={saveFinishedInput}
                            onChange={v => { dirtyRef.current = true; setValuationRows(rows => rows.map((r, j) => j === i ? { ...r, yield: Number(v) } : r)) }}
                            suffix="%"
                          />
                        </td>
                        <td className="py-2 text-right num font-semibold">
                          {targetPrice > 0 ? `¥${targetPrice.toFixed(1)}` : '—'}
                        </td>
                        <td className="py-2 text-right">
                          <Badge variant={badge}>{row.label}</Badge>
                        </td>
                        <td className={cn('py-2 text-right num', diff != null ? changeClass(diff) : '')}>
                          {diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* 当前股价所处区间说明 */}
              {expectedDps > 0 && currentPrice > 0 && (() => {
                const prices = valuationRows.map(r => ({ price: expectedDps / (r.yield / 100), label: r.label })).sort((a, b) => b.price - a.price)
                let zone = ''
                if (currentPrice >= prices[0].price) zone = `高于${prices[0].label}线，股价偏贵`
                else if (currentPrice <= prices[prices.length - 1].price) zone = `低于${prices[prices.length - 1].label}线，股价便宜`
                else zone = `处于${prices[prices.length - 1].label}与${prices[0].label}区间之间`
                return (
                  <p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
                    当前股价 ¥{fmtPrice(currentPrice)} {zone}
                  </p>
                )
              })()}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div>
                <p className="text-xs font-medium text-foreground">分红方案</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">数据来自 Tushare dividend，刷新当前股票时同步更新</p>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Button type="button" variant="outline" size="sm" disabled={planPage <= 1} onClick={() => void loadDividendPlansPage(planPage - 1)}>上一页</Button>
                <span className="num">{planPage}/{totalPlanPages}</span>
                <Button type="button" variant="outline" size="sm" disabled={planPage >= totalPlanPages} onClick={() => void loadDividendPlansPage(planPage + 1)}>下一页</Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-3 py-2 text-left text-muted-foreground font-medium">报告期</th>
                    <th className="px-3 py-2 text-left text-muted-foreground font-medium">分红方案</th>
                    <th className="px-3 py-2 text-left text-muted-foreground font-medium">除权除息日</th>
                    <th className="px-3 py-2 text-left text-muted-foreground font-medium">股权登记日</th>
                    <th className="px-3 py-2 text-left text-muted-foreground font-medium">实施公告日</th>
                  </tr>
                </thead>
                <tbody>
                  {plansData.rows?.length ? plansData.rows.map((row, i) => (
                    <tr key={row.id ?? i} className={cn('border-b border-border last:border-0', i % 2 === 1 && 'bg-muted/20')}>
                      <td className="px-3 py-2 num">{row.end_date || '—'}</td>
                      <td className="px-3 py-2 text-foreground min-w-[9rem]">{row.plan_text || '—'}</td>
                      <td className="px-3 py-2 num">{row.ex_date || '—'}</td>
                      <td className="px-3 py-2 num">{row.record_date || '—'}</td>
                      <td className="px-3 py-2 num">{row.imp_ann_date || '—'}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={5} className="px-3 py-5 text-center text-muted-foreground">暂无分红方案，请点击右上角刷新获取</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {uiState === 'loading' && (
        <div className="flex items-center justify-center py-24 text-muted-foreground text-sm">
          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />加载中…
        </div>
      )}

      {uiState === 'idle' && (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground text-sm">
          从上方选择持仓股票开始分析
        </div>
      )}
    </div>
  )
}
