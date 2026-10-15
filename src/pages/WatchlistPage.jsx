import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, RefreshCw, Star, Trash2, TrendingDown, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { cn, fmtPct, fmtPrice, changeClass } from '@/lib/utils'
import { deleteWatchlistStock, fetchWatchlist } from '@/services/watchlist'
import { fetchMarketDataMap } from '@/services/marketData'
import { refreshStockDetail } from '@/services/stockDetails'
import { VALUATION_UPDATED_EVENT } from '@/services/dividendRecords'

const TEXT = {
  loadError: '\u52a0\u8f7d\u81ea\u9009\u80a1\u5931\u8d25\uff1a',
  loading: '\u52a0\u8f7d\u4e2d...',
  failed: '\u52a0\u8f7d\u5931\u8d25',
  retry: '\u91cd\u8bd5',
  title: '\u81ea\u9009\u80a1',
  subtitleSuffix: '\u53ea\u6807\u7684 \u00b7 \u80a1\u606f\u4f30\u503c\u6c60\u4e2d\u5c1a\u672a\u6301\u4ed3\u7684\u80a1\u7968',
  refresh: '\u5237\u65b0\u5217\u8868',
  refreshing: '\u5237\u65b0\u4e2d',
  refreshEmpty: '\u5f53\u524d\u6ca1\u6709\u81ea\u9009\u80a1\u9700\u8981\u5237\u65b0',
  refreshDone: '\u81ea\u9009\u80a1\u8be6\u60c5\u5df2\u5237\u65b0',
  refreshPartial: '\u81ea\u9009\u80a1\u90e8\u5206\u5237\u65b0',
  refreshFailed: '\u5237\u65b0\u81ea\u9009\u80a1\u8be6\u60c5\u5931\u8d25\uff1a',
  empty: '\u6682\u65e0\u81ea\u9009\u80a1\uff0c\u80a1\u606f\u4f30\u503c\u9875\u4e2d\u672a\u6301\u4ed3\u7684\u80a1\u7968\u4f1a\u663e\u793a\u5728\u8fd9\u91cc',
  badge: '\u81ea\u9009',
  close: '\u5f53\u524d\u4ef7',
  change: '\u6da8\u8dcc\u5e45',
  expectedYield: '\u9884\u671f\u80a1\u606f\u7387',
  detail: '\u67e5\u770b\u8be6\u60c5',
  delete: '\u5220\u9664',
  deleteTitle: '\u5220\u9664\u81ea\u9009\u80a1',
  deletePrefix: '\u786e\u8ba4\u5220\u9664',
  deleteSuffix: '\u7684\u81ea\u9009\u8bb0\u5f55\uff1f\u5bf9\u5e94\u7684\u80a1\u606f\u4f30\u503c\u6570\u636e\u4e5f\u4f1a\u4e00\u5e76\u5220\u9664\u3002',
  cancel: '\u53d6\u6d88',
  deleting: '\u5220\u9664\u4e2d',
  confirmDelete: '\u786e\u8ba4\u5220\u9664',
  deleteSuccess: '\u81ea\u9009\u80a1\u5df2\u5220\u9664',
  deleteError: '\u5220\u9664\u5931\u8d25\uff1a',
}

function displayExpectedYield(value) {
  if (value == null || value === '') return '--'
  const n = Number(value)
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '--'
}

function getClosePrice(stock, marketDataMap) {
  const fromStock = Number(stock.last_close_price)
  if (Number.isFinite(fromStock) && fromStock > 0) return fromStock
  const fromMarket = Number(marketDataMap[stock.stock_code]?.close_price)
  if (Number.isFinite(fromMarket) && fromMarket > 0) return fromMarket
  return 0
}

function getChangePct(stock, marketDataMap) {
  const fromStock = Number(stock.last_change_pct)
  if (stock.last_change_pct != null && stock.last_change_pct !== '' && Number.isFinite(fromStock)) return fromStock
  return Number(marketDataMap[stock.stock_code]?.daily_change_rate) || 0
}

export default function WatchlistPage({ onSelectStock }) {
  const toast = useToast()
  const [stocks, setStocks] = useState([])
  const [marketDataMap, setMarketDataMap] = useState({})
  const [uiState, setUiState] = useState('loading')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const loadVersionRef = useRef(0)

  async function loadWatchlist({ silent = false } = {}) {
    const version = ++loadVersionRef.current
    if (!silent) setUiState('loading')
    try {
      const [data, mdMap] = await Promise.all([fetchWatchlist(), fetchMarketDataMap()])
      if (version !== loadVersionRef.current) return
      setStocks(data)
      setMarketDataMap(mdMap)
      setUiState('loaded')
    } catch (error) {
      if (version !== loadVersionRef.current) return
      if (!silent) setUiState('error')
      toast({ title: `${TEXT.loadError}${error.message}`, variant: 'destructive' })
    }
  }

  function openDelete(stock) {
    setDeleteTarget(stock)
    setDeleteOpen(true)
  }

  async function handleDelete() {
    if (!deleteTarget?.stock_code) return
    setDeleteSubmitting(true)
    try {
      await deleteWatchlistStock(deleteTarget.stock_code)
      setStocks(prev => prev.filter(stock => stock.stock_code !== deleteTarget.stock_code))
      setDeleteOpen(false)
      setDeleteTarget(null)
      toast({ title: TEXT.deleteSuccess })
    } catch (error) {
      toast({ title: `${TEXT.deleteError}${error.message}`, variant: 'destructive' })
    } finally {
      setDeleteSubmitting(false)
    }
  }

  async function handleRefreshList() {
    if (refreshing) return
    const targets = stocks.filter(stock => stock.stock_code)
    if (targets.length === 0) {
      toast({ title: TEXT.refreshEmpty })
      return
    }

    setRefreshing(true)
    try {
      const errors = []
      let updated = 0
      for (const stock of targets) {
        try {
          await refreshStockDetail(stock.stock_code)
          updated += 1
        } catch (error) {
          errors.push(`${stock.stock_name || stock.stock_code}: ${error.message || String(error)}`)
        }
      }
      await loadWatchlist()
      toast({
        title: errors.length ? TEXT.refreshPartial : TEXT.refreshDone,
        description: errors.length
          ? `\u5df2\u5237\u65b0 ${updated}/${targets.length} \u53ea\uff1b${errors.slice(0, 3).join('\uff1b')}`
          : `\u5df2\u5237\u65b0 ${updated} \u53ea`,
        variant: errors.length ? 'destructive' : undefined,
      })
    } catch (error) {
      toast({ title: `${TEXT.refreshFailed}${error.message}`, variant: 'destructive' })
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    const onValuationSaved = () => { void loadWatchlist({ silent: true }) }
    window.addEventListener(VALUATION_UPDATED_EVENT, onValuationSaved)
    void loadWatchlist()
    return () => {
      window.removeEventListener(VALUATION_UPDATED_EVENT, onValuationSaved)
      loadVersionRef.current++
    }
  }, [])

  const enrichedStocks = useMemo(() => {
    return stocks.map(stock => ({
      stock,
      close: getClosePrice(stock, marketDataMap),
      change: getChangePct(stock, marketDataMap),
    }))
  }, [stocks, marketDataMap])

  if (uiState === 'loading') {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />{TEXT.loading}
      </div>
    )
  }

  if (uiState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-muted-foreground">{TEXT.failed}</p>
        <Button size="sm" onClick={loadWatchlist}>{TEXT.retry}</Button>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{TEXT.title}</h1>
          <p className="text-xs text-muted-foreground mt-1">{stocks.length} {TEXT.subtitleSuffix}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefreshList} disabled={refreshing}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', refreshing && 'animate-spin')} />
          {refreshing ? TEXT.refreshing : TEXT.refresh}
        </Button>
      </div>

      {stocks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center mb-3">
            <Star className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">{TEXT.empty}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {enrichedStocks.map(({ stock, close, change }) => (
            <div
              key={stock.stock_code}
              className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-4 hover:border-primary/30 transition-colors group"
            >
              <div className="w-36 shrink-0">
                <p className="text-xs text-muted-foreground num">{stock.stock_code}</p>
                <p className="text-sm font-medium text-foreground mt-0.5 truncate">{stock.stock_name}</p>
              </div>
              <div className="w-20 shrink-0">
                <span className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">{TEXT.badge}</span>
              </div>
              <div className="w-24 shrink-0">
                <p className={cn('text-sm font-semibold num', close > 0 ? changeClass(change) : 'text-muted-foreground')}>
                  {close > 0 ? fmtPrice(close) : '--'}
                </p>
                <p className={cn('text-xs num', changeClass(change))}>
                  {change >= 0 ? <TrendingUp className="inline h-3 w-3 mr-0.5" /> : <TrendingDown className="inline h-3 w-3 mr-0.5" />}
                  {fmtPct(change)}
                </p>
              </div>
              <div className="flex-1 grid grid-cols-3 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">{TEXT.close}</p>
                  <p className="text-foreground num mt-0.5">{close > 0 ? `\u00a5${fmtPrice(close)}` : '--'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{TEXT.change}</p>
                  <p className={cn('num mt-0.5', changeClass(change))}>{fmtPct(change)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{TEXT.expectedYield}</p>
                  <p className="text-primary font-semibold num mt-0.5">{displayExpectedYield(stock.expected_dividend_yield)}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon" onClick={() => onSelectStock(stock)} title={TEXT.detail}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => openDelete(stock)} title={TEXT.delete} className="hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={deleteOpen}
        onOpenChange={open => {
          if (deleteSubmitting) return
          setDeleteOpen(open)
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{TEXT.deleteTitle}</DialogTitle>
            <DialogDescription>
              {TEXT.deletePrefix} <span className="text-foreground font-medium">{deleteTarget?.stock_name}</span> {TEXT.deleteSuffix}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteSubmitting}>{TEXT.cancel}</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteSubmitting || !deleteTarget}>
              {deleteSubmitting ? TEXT.deleting : TEXT.confirmDelete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}