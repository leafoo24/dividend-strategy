import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownUp,
  BarChart3,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { cn, fmtPct, fmtPrice, changeClass } from '@/lib/utils'
import { fetchHoldings, createHolding, updateHolding, deleteHolding } from '@/services/holdings'
import { fetchMarketDataMap, refreshMarketData } from '@/services/marketData'
import { fetchPortfolioTargets, savePortfolioTargets, fetchAvailableCash, saveAvailableCash } from '@/services/portfolio'
import { fetchAnnualDividendIncome, saveAnnualDividendIncome } from '@/services/annualDividendIncome'
import { summarizeExpectedDividends } from '@/lib/portfolioDividends'
import { SORTABLE_HOLDING_COLUMNS, getNextHoldingSort, sortHoldingsForDisplay } from '@/lib/holdingSort'

const CATEGORIES = [
  { key: 'core_dividend', label: '红利', short: '红利', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { key: 'gold', label: '黄金', short: '黄金', tone: 'bg-amber-50 text-amber-700 border-amber-200' },
  { key: 'technology', label: '科技', short: '科技', tone: 'bg-sky-50 text-sky-700 border-sky-200' },
  { key: 'cycle', label: '周期', short: '周期', tone: 'bg-rose-50 text-rose-700 border-rose-200' },
]

const EMPTY_FORM = {
  stock_code: '',
  stock_name: '',
  cost_price: '',
  quantity: '',
  asset_category: 'core_dividend',
}

function categoryMeta(key) {
  return CATEGORIES.find(category => category.key === key) ?? CATEGORIES[0]
}

function displayNumber(value, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function displayAmount(value) {
  return `¥${displayNumber(value)}`
}

function displayExpectedYield(value) {
  if (value == null || value === '') return '--'
  const n = Number(value)
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '--'
}

function getClosePrice(holding, marketDataMap) {
  const fromHolding = Number(holding.last_close_price)
  if (Number.isFinite(fromHolding) && fromHolding > 0) return fromHolding
  const fromMarket = Number(marketDataMap[holding.stock_code]?.close_price)
  if (Number.isFinite(fromMarket) && fromMarket > 0) return fromMarket
  return Number(holding.cost_price) || 0
}

function calcHolding(holding, marketDataMap) {
  const quantity = Number(holding.quantity) || 0
  const costPrice = Number(holding.cost_price) || 0
  const close = getClosePrice(holding, marketDataMap)
  const cost = costPrice * quantity
  const value = close * quantity
  const pnl = value - cost
  const pnlPct = cost > 0 ? pnl / cost * 100 : 0
  const change = holding.last_change_pct != null && holding.last_change_pct !== '' && Number.isFinite(Number(holding.last_change_pct))
    ? Number(holding.last_change_pct)
    : (Number(marketDataMap[holding.stock_code]?.daily_change_rate) || 0)
  return { quantity, costPrice, close, cost, value, pnl, pnlPct, change }
}

export default function HoldingListPage({ onSelectStock }) {
  const toast = useToast()
  const [holdings, setHoldings] = useState([])
  const [marketDataMap, setMarketDataMap] = useState({})
  const [targets, setTargets] = useState([])
  const [uiState, setUiState] = useState('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [annualDividend, setAnnualDividend] = useState(null)
  const [annualDividendOpen, setAnnualDividendOpen] = useState(false)
  const [annualDividendDraft, setAnnualDividendDraft] = useState('')
  const [annualDividendSaving, setAnnualDividendSaving] = useState(false)
  const [holdingSort, setHoldingSort] = useState(null)
  const [cash, setCash] = useState(0)
  const [cashOpen, setCashOpen] = useState(false)
  const [cashDraft, setCashDraft] = useState('')
  const [cashSaving, setCashSaving] = useState(false)
  const [cashError, setCashError] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [formData, setFormData] = useState(EMPTY_FORM)
  const [editId, setEditId] = useState(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formErrors, setFormErrors] = useState({})

  const [targetOpen, setTargetOpen] = useState(false)
  const [targetDraft, setTargetDraft] = useState({})
  const [targetSubmitting, setTargetSubmitting] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)

  async function loadHoldings() {
    setUiState('loading')
    try {
      const [data, mdMap, targetRows, annualDividendRow, cashRow] = await Promise.all([
        fetchHoldings(),
        fetchMarketDataMap(),
        fetchPortfolioTargets(),
        fetchAnnualDividendIncome(),
        fetchAvailableCash(),
      ])
      setHoldings(data)
      setMarketDataMap(mdMap)
      setTargets(targetRows)
      setAnnualDividend(annualDividendRow)
      setCash(cashRow.amount)
      setUiState('loaded')
    } catch (error) {
      setUiState('error')
      toast({ title: `加载持仓失败：${error.message}`, variant: 'destructive' })
    }
  }

  async function reloadHoldingsAndMarket() {
    const [data, mdMap] = await Promise.all([fetchHoldings(), fetchMarketDataMap()])
    setHoldings(data)
    setMarketDataMap(mdMap)
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const result = await refreshMarketData()
      await reloadHoldingsAndMarket()
      if (result?.message === 'no holdings') {
        toast({ title: '当前没有 active 持仓，未请求行情' })
        return
      }
      const extra = result && typeof result === 'object'
        ? ` · 持仓 ${result.updated_holdings ?? '--'}/${result.holdings_total ?? '--'} 只`
        : ''
      toast({ title: `行情已刷新${extra}` })
    } catch (error) {
      toast({ title: `刷新失败：${error.message}`, variant: 'destructive' })
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { loadHoldings() }, [])

  const targetMap = useMemo(() => Object.fromEntries(targets.map(row => [row.asset_category, Number(row.target_pct) || 0])), [targets])

  const portfolio = useMemo(() => {
    const enriched = holdings.map(holding => ({ holding, metrics: calcHolding(holding, marketDataMap) }))
    const totalValue = enriched.reduce((sum, row) => sum + row.metrics.value, 0)
    const totalCost = enriched.reduce((sum, row) => sum + row.metrics.cost, 0)
    const pnl = totalValue - totalCost
    const pnlPct = totalCost > 0 ? pnl / totalCost * 100 : 0
    const allocation = CATEGORIES.map(category => {
      const value = enriched
        .filter(row => (row.holding.asset_category ?? 'core_dividend') === category.key)
        .reduce((sum, row) => sum + row.metrics.value, 0)
      const actualPct = totalValue > 0 ? value / totalValue * 100 : 0
      const targetPct = targetMap[category.key] ?? 0
      const deviation = actualPct - targetPct
      const targetValue = totalValue * targetPct / 100
      return { ...category, value, actualPct, targetPct, deviation, gapValue: targetValue - value }
    })
    const driftAbs = allocation.reduce((sum, row) => sum + Math.abs(row.deviation), 0)
    return { enriched, totalValue, totalCost, pnl, pnlPct, allocation, driftAbs, expectedDividends: summarizeExpectedDividends(enriched) }
  }, [holdings, marketDataMap, targetMap])

  const sortedHoldings = useMemo(() => sortHoldingsForDisplay(portfolio.enriched, holdingSort), [portfolio.enriched, holdingSort])

  function openCashEditor() {
    setCashDraft(String(cash))
    setCashError('')
    setCashOpen(true)
  }
  async function handleSaveCash(event) {
    event.preventDefault()
    const amount = Number(cashDraft)
    if (!/^\d+(\.\d{1,2})?$/.test(cashDraft.trim()) || !Number.isFinite(amount) || amount > Number.MAX_SAFE_INTEGER / 100) {
      setCashError('请输入大于等于 0 的金额，最多保留两位小数')
      return
    }
    setCashSaving(true)
    try {
      const saved = await saveAvailableCash(amount)
      setCash(saved.amount)
      setCashOpen(false)
      toast({ title: '可用现金已保存' })
    } catch (error) {
      setCashError('保存失败：' + error.message)
    } finally { setCashSaving(false) }
  }

  function openAdd() {
    setFormData(EMPTY_FORM)
    setEditId(null)
    setFormErrors({})
    setFormOpen(true)
  }

  function openEdit(holding) {
    setFormData({
      stock_code: holding.stock_code,
      stock_name: holding.stock_name,
      cost_price: String(holding.cost_price),
      quantity: String(holding.quantity),
      asset_category: holding.asset_category ?? 'core_dividend',
    })
    setEditId(holding.id)
    setFormErrors({})
    setFormOpen(true)
  }

  function validateForm() {
    const errors = {}
    if (!formData.stock_code.trim()) errors.stock_code = true
    if (!formData.stock_name.trim()) errors.stock_name = true
    if (!formData.cost_price || !Number.isFinite(Number(formData.cost_price)) || Number(formData.cost_price) <= 0) errors.cost_price = true
    if (!formData.quantity || !Number.isFinite(Number(formData.quantity)) || Number(formData.quantity) <= 0) errors.quantity = true
    return errors
  }

  async function handleSave() {
    const errors = validateForm()
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors)
      return
    }
    setFormSubmitting(true)
    const payload = {
      stock_code: formData.stock_code.trim(),
      stock_name: formData.stock_name.trim(),
      cost_price: Number(formData.cost_price),
      quantity: Number(formData.quantity),
      asset_category: formData.asset_category,
    }
    try {
      if (editId) {
        const updated = await updateHolding(editId, payload)
        setHoldings(prev => prev.map(holding => holding.id === editId ? updated : holding))
      } else {
        const created = await createHolding(payload)
        setHoldings(prev => [...prev, created])
      }
      setFormOpen(false)
      toast({ title: '持仓已保存' })
    } catch (error) {
      toast({ title: `保存失败：${error.message}`, variant: 'destructive' })
    } finally {
      setFormSubmitting(false)
    }
  }

  function openTargets() {
    setTargetDraft(Object.fromEntries(CATEGORIES.map(category => [category.key, String(targetMap[category.key] ?? 0)])))
    setTargetOpen(true)
  }

  function openAnnualDividendEditor() {
    setAnnualDividendDraft(annualDividend?.amount != null ? String(annualDividend.amount) : '')
    setAnnualDividendOpen(true)
  }

  async function handleSaveAnnualDividend() {
    const amount = Number(annualDividendDraft)
    if (!Number.isFinite(amount) || amount < 0) {
      toast({ title: '今年已收股息需要填写大于等于 0 的数字', variant: 'destructive' })
      return
    }
    setAnnualDividendSaving(true)
    try {
      const saved = await saveAnnualDividendIncome({ year: new Date().getFullYear(), amount })
      setAnnualDividend(saved)
      setAnnualDividendOpen(false)
      toast({ title: '今年已收股息已保存' })
    } catch (error) {
      toast({ title: '保存已收股息失败：' + error.message, variant: 'destructive' })
    } finally {
      setAnnualDividendSaving(false)
    }
  }

  async function handleSaveTargets() {
    const rows = CATEGORIES.map(category => ({
      asset_category: category.key,
      target_pct: Number(targetDraft[category.key]) || 0,
    }))
    const total = rows.reduce((sum, row) => sum + row.target_pct, 0)
    if (Math.abs(total - 100) > 0.01) {
      toast({ title: `目标比例合计需要等于 100%，当前为 ${displayNumber(total, 1)}%`, variant: 'destructive' })
      return
    }
    setTargetSubmitting(true)
    try {
      const saved = await savePortfolioTargets(rows)
      setTargets(saved)
      setTargetOpen(false)
      toast({ title: '目标比例已保存' })
    } catch (error) {
      toast({ title: `保存目标失败：${error.message}`, variant: 'destructive' })
    } finally {
      setTargetSubmitting(false)
    }
  }

  function openDelete(holding) {
    setDeleteTarget(holding)
    setDeleteOpen(true)
  }

  async function handleDelete() {
    setDeleteSubmitting(true)
    try {
      await deleteHolding(deleteTarget.id)
      setHoldings(prev => prev.filter(holding => holding.id !== deleteTarget.id))
      setDeleteOpen(false)
      toast({ title: '持仓已删除' })
    } catch (error) {
      toast({ title: `删除失败：${error.message}`, variant: 'destructive' })
    } finally {
      setDeleteSubmitting(false)
    }
  }

  if (uiState === 'loading') {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />加载中...
      </div>
    )
  }

  if (uiState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-muted-foreground">加载失败</p>
        <Button size="sm" onClick={loadHoldings}>重试</Button>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">我的持仓</h1>
          <p className="text-xs text-muted-foreground mt-1">{holdings.length} 只标的 · 红利-卫星组合视图</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', refreshing && 'animate-spin')} />
            {refreshing ? '刷新中' : '刷新行情'}
          </Button>
          <Button variant="outline" size="sm" onClick={openTargets}>
            <Settings2 className="h-3.5 w-3.5 mr-1.5" />
            目标比例
          </Button>
          <Button size="sm" onClick={openAdd}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            新增持仓
          </Button>
        </div>
      </div>

      <section aria-label="资产概览" className="rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">总资产</p>
            <p className="text-2xl font-semibold num mt-1 text-primary">{displayAmount(cash + portfolio.totalValue)}</p>
            <p className="text-xs text-muted-foreground mt-1">可用现金 + 持仓总市值</p>
          </div>
          <div>
            <div className="flex items-center gap-3">
              <p className="text-xs text-muted-foreground">可用现金</p>
              <button type="button" className="text-xs text-primary hover:underline" onClick={openCashEditor} aria-label="编辑可用现金">编辑</button>
            </div>
            <p className="text-xl font-semibold num mt-1">{displayAmount(cash)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">持仓总市值</p>
            <p className="text-xl font-semibold num mt-1">{displayAmount(portfolio.totalValue)}</p>
          </div>
        </div>
      </section>

      {holdings.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5 mb-4">
            <div>
              <p className="text-xs text-muted-foreground" title="持仓预期股息合计 ÷ 持仓总市值，不含现金">预期股息率</p>
              <p className="text-lg font-semibold num mt-1 text-primary">{portfolio.expectedDividends.yieldPct == null ? '--' : displayNumber(portfolio.expectedDividends.yieldPct) + '%'}{portfolio.expectedDividends.missingCount > 0 && portfolio.expectedDividends.yieldPct != null && <span className="text-xs font-normal ml-1">（已知部分）</span>}</p>
              <p className="text-xs text-muted-foreground mt-0.5">预期股息 {portfolio.expectedDividends.amount == null ? '--' : displayAmount(portfolio.expectedDividends.amount)}</p>
              {portfolio.expectedDividends.missingCount > 0 && <p className="text-xs text-muted-foreground mt-0.5">{portfolio.expectedDividends.missingCount} 只持仓缺少预测</p>}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">持仓成本</p>
              <p className="text-lg font-semibold num mt-1">{displayAmount(portfolio.totalCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">浮动盈亏</p>
              <p className={cn('text-lg font-semibold num mt-1', changeClass(portfolio.pnl))}>
                {portfolio.pnl >= 0 ? '+' : ''}{displayAmount(portfolio.pnl)} <span className="text-sm">{fmtPct(portfolio.pnlPct)}</span>
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">组合偏离度</p>
              <p className={cn('text-lg font-semibold num mt-1', portfolio.driftAbs <= 12 ? 'text-emerald-600' : 'text-amber-600')}>
                {displayNumber(portfolio.driftAbs, 1)} pp
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">今年已收股息</p>
                <button type="button" className="text-[11px] text-primary hover:underline" onClick={openAnnualDividendEditor}>编辑</button>
              </div>
              <p className="text-lg font-semibold num mt-1">{displayAmount(annualDividend?.amount ?? 0)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                成本股息率 {annualDividend?.dividend_yield_on_cost != null ? fmtPct(annualDividend.dividend_yield_on_cost) : '--'}
                {annualDividend?.updated_at && <span className="block">更新 {new Date(annualDividend.updated_at).toLocaleDateString('zh-CN')}</span>}
              </p>
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <p className="text-xs text-muted-foreground mb-2">持仓配置 <span className="ml-1">· 按持仓市值计算</span></p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
              {portfolio.allocation.map(row => (
                <div key={row.key} className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('inline-flex rounded border px-1.5 py-0.5 text-xs font-medium', row.tone)}>{row.label}</span>
                    <span className="text-sm font-semibold num">{displayNumber(row.actualPct, 1)}%</span>
                  </div>
                  <div className="text-right text-xs whitespace-nowrap">
                    <p className="text-muted-foreground num">目标 {displayNumber(row.targetPct, 1)}%</p>
                    <p className={cn('num', Math.abs(row.deviation) <= 3 ? 'text-emerald-600' : row.deviation > 0 ? 'text-rose-600' : 'text-amber-600')}>偏离 {row.deviation >= 0 ? '+' : ''}{displayNumber(row.deviation, 1)} pp</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {holdings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center mb-3">
            <Plus className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">暂无持仓，点击新增开始追踪</p>
          <Button size="sm" className="mt-4" onClick={openAdd}>新增持仓</Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <ArrowDownUp className="h-3.5 w-3.5" />
              {'\u6392\u5e8f'}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {SORTABLE_HOLDING_COLUMNS.map(column => {
                const active = holdingSort?.key === column.key
                return (
                  <Button
                    key={column.key}
                    type="button"
                    variant={active ? 'secondary' : 'ghost'}
                    size="sm"
                    className={cn('h-7 px-2 text-xs', active && 'text-foreground')}
                    onClick={() => setHoldingSort(prev => getNextHoldingSort(prev, column.key))}
                  >
                    {column.label}
                    {active && (
                      holdingSort.direction === 'desc'
                        ? <ChevronDown className="ml-1 h-3 w-3" />
                        : <ChevronUp className="ml-1 h-3 w-3" />
                    )}
                  </Button>
                )
              })}
            </div>
          </div>

          {sortedHoldings.map(({ holding, metrics }) => {
            const meta = categoryMeta(holding.asset_category)
            return (
              <div
                key={holding.id}
                className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-4 hover:border-primary/30 transition-colors group"
              >
                <div className="w-36 shrink-0">
                  <p className="text-xs text-muted-foreground num">{holding.stock_code}</p>
                  <p className="text-sm font-medium text-foreground mt-0.5 truncate">{holding.stock_name}</p>
                </div>
                <div className="w-20 shrink-0">
                  <span className={cn('inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium', meta.tone)}>{meta.short}</span>
                </div>
                <div className="w-24 shrink-0">
                  <p className={cn('text-sm font-semibold num', changeClass(metrics.change))}>{fmtPrice(metrics.close)}</p>
                  <p className={cn('text-xs num', changeClass(metrics.change))}>
                    {metrics.change >= 0 ? <TrendingUp className="inline h-3 w-3 mr-0.5" /> : <TrendingDown className="inline h-3 w-3 mr-0.5" />}
                    {fmtPct(metrics.change)}
                  </p>
                </div>
                <div className="flex-1 grid grid-cols-5 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">市值</p>
                    <p className="text-foreground num mt-0.5">{displayAmount(metrics.value)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">数量</p>
                    <p className="text-foreground num mt-0.5">{displayNumber(metrics.quantity, 0)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">成本价</p>
                    <p className="text-foreground num mt-0.5">¥{fmtPrice(metrics.costPrice)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">浮动盈亏</p>
                    <p className={cn('num mt-0.5', changeClass(metrics.pnl))}>
                      {metrics.pnl >= 0 ? '+' : ''}{displayAmount(metrics.pnl)} ({fmtPct(metrics.pnlPct)})
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{'\u9884\u671f\u80a1\u606f\u7387'}</p>
                    <p className="text-primary font-semibold num mt-0.5">{displayExpectedYield(holding.expected_dividend_yield)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon" onClick={() => onSelectStock(holding)} title="查看详情">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => openEdit(holding)} title="编辑">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => openDelete(holding)} title="删除" className="hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Dialog open={cashOpen} onOpenChange={open => { if (!cashSaving) setCashOpen(open) }}>
        <DialogContent className="max-w-sm">
          <form onSubmit={handleSaveCash} className="space-y-4">
            <DialogHeader>
              <DialogTitle>编辑可用现金</DialogTitle>
              <DialogDescription>填写当前可用现金余额，保存后计入总资产。</DialogDescription>
            </DialogHeader>
            <div>
              <label htmlFor="available-cash" className="text-xs text-muted-foreground mb-1 block">可用现金（元）</label>
              <Input id="available-cash" inputMode="decimal" autoFocus value={cashDraft}
                onChange={event => { setCashDraft(event.target.value); setCashError('') }}
                placeholder="例如 10000.00" className="num" disabled={cashSaving}
                aria-invalid={Boolean(cashError)} aria-describedby={cashError ? 'cash-error' : undefined} />
              {cashError && <p id="cash-error" role="alert" className="text-xs text-destructive mt-1">{cashError}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={cashSaving} onClick={() => setCashOpen(false)}>取消</Button>
              <Button type="submit" disabled={cashSaving}>{cashSaving ? '保存中' : '保存'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? '编辑持仓' : '新增持仓'}</DialogTitle>
            <DialogDescription>填写标的、成本、数量和资产类别。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">资产类别</label>
              <select
                value={formData.asset_category}
                onChange={event => setFormData(prev => ({ ...prev, asset_category: event.target.value }))}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
              >
                {CATEGORIES.map(category => <option key={category.key} value={category.key}>{category.label}</option>)}
              </select>
            </div>
            {[
              { key: 'stock_code', label: '股票代码', placeholder: '例如 600900' },
              { key: 'stock_name', label: '股票名称', placeholder: '例如 长江电力' },
              { key: 'cost_price', label: '持仓成本价（元）', placeholder: '例如 25.137' },
              { key: 'quantity', label: '持仓数量', placeholder: '例如 300' },
            ].map(field => (
              <div key={field.key}>
                <label className="text-xs text-muted-foreground mb-1 block">{field.label}</label>
                <Input
                  placeholder={field.placeholder}
                  value={formData[field.key]}
                  onChange={event => setFormData(prev => ({ ...prev, [field.key]: event.target.value }))}
                  className={cn(formErrors[field.key] && 'border-destructive focus:ring-destructive')}
                />
                {formErrors[field.key] && <p className="text-xs text-destructive mt-1">此项为必填，且数值需要大于 0</p>}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
            <Button onClick={handleSave} disabled={formSubmitting}>{formSubmitting ? '保存中' : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <Dialog open={annualDividendOpen} onOpenChange={setAnnualDividendOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>更新今年已收股息</DialogTitle>
            <DialogDescription>输入今年累计收到的现金股息，系统会记录本次更新时间，并按当前持仓成本计算股息率。</DialogDescription>
          </DialogHeader>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">今年已收股息（元）</label>
            <Input
              value={annualDividendDraft}
              onChange={event => setAnnualDividendDraft(event.target.value)}
              placeholder="例如 1800"
              className="num text-right"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAnnualDividendOpen(false)}>取消</Button>
            <Button onClick={handleSaveAnnualDividend} disabled={annualDividendSaving}>{annualDividendSaving ? '保存中' : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={targetOpen} onOpenChange={setTargetOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Target className="h-4 w-4" />目标比例设置</DialogTitle>
            <DialogDescription>四类资产目标比例合计需要等于 100%。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {portfolio.allocation.map(row => (
              <div key={row.key} className="grid grid-cols-[1fr_96px_96px] items-center gap-3 rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-xs text-muted-foreground">当前 {displayNumber(row.actualPct, 1)}% · 偏离 {row.deviation >= 0 ? '+' : ''}{displayNumber(row.deviation, 1)} pp</p>
                </div>
                <div className="text-xs text-muted-foreground num text-right">{displayAmount(row.value)}</div>
                <div className="flex items-center gap-1">
                  <Input
                    value={targetDraft[row.key] ?? ''}
                    onChange={event => setTargetDraft(prev => ({ ...prev, [row.key]: event.target.value }))}
                    className="h-8 text-right num"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTargetOpen(false)}>取消</Button>
            <Button onClick={handleSaveTargets} disabled={targetSubmitting}>
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              {targetSubmitting ? '保存中' : '保存目标'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除持仓</DialogTitle>
            <DialogDescription>
              确认删除 <span className="text-foreground font-medium">{deleteTarget?.stock_name}</span> 的持仓记录？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteSubmitting}>{deleteSubmitting ? '删除中' : '确认删除'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
