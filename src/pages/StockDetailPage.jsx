import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, Newspaper, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import TradeJournal from './TradeJournal'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/toast'
import { cn, fmtPct, fmtPrice, changeClass } from '@/lib/utils'
import { fetchStockDetail, refreshStockDetail } from '@/services/stockDetails'

function StatCard({ label, value, sub, cls }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 min-h-[82px]">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={cn('text-sm font-semibold num', cls)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground num mt-0.5">{sub}</p>}
    </div>
  )
}

function dash(value) {
  return value == null || value === '' ? '--' : value
}

function money(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function percent(value, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return fmtPct(n, digits)
}

function normalizeDetail(raw, fallbackStock) {
  const holding = raw?.holding ?? fallbackStock
  const metrics = raw?.metrics ?? {}
  const quote = raw?.quote ?? {}
  const close = Number(metrics.close_price ?? quote.close_price ?? holding.last_close_price ?? holding.cost_price ?? 0)
  const change = Number(metrics.daily_change_rate ?? quote.daily_change_rate ?? holding.last_change_pct ?? 0)
  const quantity = Number(holding.quantity ?? 0)
  const costPrice = Number(holding.cost_price ?? 0)
  const pnl = (close - costPrice) * quantity
  const pnlPct = costPrice > 0 ? ((close - costPrice) / costPrice) * 100 : 0
  return {
    stock_code: raw?.stock_code ?? holding.stock_code,
    stock_name: raw?.stock_name || holding.stock_name || quote.stock_name || metrics.stock_name || '',
    holding,
    quote,
    metrics: { ...metrics, close_price: close, daily_change_rate: change },
    announcements: raw?.announcements ?? [],
    pnl,
    pnlPct,
  }
}

export default function StockDetailPage({ stock, onBack }) {
  const toast = useToast()
  const [detail, setDetail] = useState(null)
  const [uiState, setUiState] = useState('loading')
  const [refreshing, setRefreshing] = useState(false)

  async function loadDetail() {
    setUiState('loading')
    try {
      const data = await fetchStockDetail(stock.stock_code)
      setDetail(normalizeDetail(data, stock))
      setUiState('loaded')
    } catch (error) {
      setDetail(normalizeDetail(null, stock))
      setUiState('error')
      toast({ title: `加载详情失败：${error.message}`, variant: 'destructive' })
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const result = await refreshStockDetail(stock.stock_code)
      setDetail(normalizeDetail(result.detail, stock))
      const warningText = result.warnings?.length ? ` · ${result.warnings.length} 个数据源有提示` : ''
      toast({ title: `详情已刷新${warningText}` })
    } catch (error) {
      toast({ title: `刷新失败：${error.message}`, variant: 'destructive' })
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { loadDetail() }, [stock.stock_code])

  const view = useMemo(() => detail ?? normalizeDetail(null, stock), [detail, stock])
  const metrics = view.metrics
  const holding = view.holding
  const isDividend = holding?.asset_category === 'core_dividend'
  const lastUpdated = metrics.updated_at || view.quote?.fetched_at || holding?.market_quotes_at

  if (uiState === 'loading' && !detail) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />加载详情中...
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold">{view.stock_name || stock.stock_name}</h1>
              <span className="text-xs text-muted-foreground num">{view.stock_code}</span>
              {isDividend && <Badge variant="info">红利</Badge>}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">最后更新：{lastUpdated ? String(lastUpdated).slice(0, 10) : '--'}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', refreshing && 'animate-spin')} />
          {refreshing ? '刷新中' : '刷新'}
        </Button>
      </div>

      <section className="mb-5">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">技术面</p>
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="收盘价" value={`¥${fmtPrice(Number(metrics.close_price) || 0)}`} cls={changeClass(Number(metrics.daily_change_rate) || 0)} />
          <StatCard
            label="日涨跌幅"
            value={percent(metrics.daily_change_rate)}
            sub={(Number(metrics.daily_change_rate) || 0) >= 0 ? '上涨' : '下跌'}
            cls={changeClass(Number(metrics.daily_change_rate) || 0)}
          />
          <StatCard label="20日动量" value={percent(metrics.momentum_20d)} cls={changeClass(Number(metrics.momentum_20d) || 0)} />
          <StatCard label="PE / PB" value={`${dash(metrics.pe_ttm != null ? Number(metrics.pe_ttm).toFixed(2) : null)} / ${dash(metrics.pb != null ? Number(metrics.pb).toFixed(2) : null)}`} />
        </div>
      </section>

      <section className="mb-5">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">持仓与红利</p>
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="持仓成本" value={`¥${fmtPrice(Number(holding.cost_price) || 0)}`} />
          <StatCard label="持仓数量" value={`${Number(holding.quantity ?? 0).toLocaleString('zh-CN')} 股`} />
          <StatCard label="持仓浮盈" value={`${view.pnl >= 0 ? '+' : ''}${money(view.pnl)}`} sub={percent(view.pnlPct)} cls={changeClass(view.pnl)} />
          {isDividend ? (
            <StatCard
              label="今年已派息"
              value={money(metrics.dividend_paid_value_ytd)}
              sub={`股息率 ${percent(metrics.holding_dividend_yield_ytd)}`}
              cls="text-primary"
            />
          ) : (
            <StatCard label="资产类别" value="非红利持仓" sub="不计算持仓股息" />
          )}
        </div>
      </section>

      <TradeJournal stockCode={view.stock_code} stockName={view.stock_name} currentPrice={metrics.close_price} costPrice={holding.cost_price} quantity={holding.quantity} onHoldingChange={loadDetail} />

      <section>
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">消息面 · 最新5条</p>
        <div className="space-y-2">
          {view.announcements.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              暂无公告缓存，点击右上角刷新获取。
            </div>
          ) : view.announcements.map((item, index) => {
            const content = (
              <div className="rounded-lg border border-border bg-card px-4 py-3 hover:border-primary/40 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="info"><Newspaper className="inline h-3 w-3 mr-0.5" />{item.source || '公告'}</Badge>
                      <span className="text-xs text-muted-foreground num">{item.published_at || '--'}</span>
                    </div>
                    <p className="text-sm text-foreground font-medium leading-snug">{item.title}</p>
                    {item.summary && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{item.summary}</p>}
                  </div>
                  {item.url && <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />}
                </div>
              </div>
            )
            return item.url ? (
              <a key={`${item.title}-${index}`} href={item.url} target="_blank" rel="noreferrer" className="block">
                {content}
              </a>
            ) : (
              <div key={`${item.title}-${index}`}>{content}</div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
