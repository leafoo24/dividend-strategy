import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, ClipboardPenLine, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { fetchJournal, saveJournal } from '@/services/journal'

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const money = n => `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const shortDate = date => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`
const area = 'w-full min-h-[72px] resize-y rounded-md border border-border bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary'
function Field({ label, error, children }) {
  return <label className="block space-y-1.5 text-xs font-medium"><span>{label}</span>{children}{error && <span className="block font-normal text-destructive">{error}</span>}</label>
}
function Detail({ label, value }) {
  return value ? <p><span className="text-muted-foreground">{label}：</span><span className="whitespace-pre-wrap">{value}</span></p> : null
}
export default function TradeJournal({ stockCode, stockName, currentPrice, costPrice, quantity, onHoldingChange }) {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState(null)
  const [errors, setErrors] = useState({})
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(null)
  async function reload() {
    setLoading(true); setLoadError('')
    try { setRows(await fetchJournal(stockCode)) }
    catch (error) { setLoadError(error.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { setRows([]); setExpanded(null); setOpen(false); reload() }, [stockCode])
  const trades = useMemo(() => rows.filter(row => row.kind === 'trade'), [rows])
  const plans = useMemo(() => rows.filter(row => row.kind === 'plan'), [rows])
  const history = useMemo(() => rows.filter(row => row.kind !== 'plan'), [rows])
  const latest = trades.reduce((best, row) => !best || row.trade_date > best.trade_date ? row : best, null)
  const first = trades.reduce((date, row) => !date || row.trade_date < date ? row.trade_date : date, '')
  const days = first ? Math.max(1, Math.floor((new Date(today()) - new Date(first)) / 86400000) + 1) : null
  const reductions = trades.filter(row => row.action === '减仓')
  const pricedReductions = reductions.filter(row => row.cost_basis != null && Number.isFinite(Number(row.cost_basis)))
  const realized = pricedReductions.reduce((sum, row) => sum + (row.price - row.cost_basis) * row.quantity, 0)
  function show(kind, row = null, linkedTrade = null) {
    const base = kind === 'trade'
      ? { kind, action: '加仓', date: today(), quantity: '', price: Number(currentPrice) || '', reason: '' }
      : kind === 'plan'
        ? { kind, action: '加仓', date: today(), judgement: '', planned_price: '', planned_position: '', reason: '' }
        : { kind, date: today(), linked_trade_id: linkedTrade, judgement: '', result: '', conclusion: '' }
    setDraft(row ? { ...base, ...row, date: row.trade_date ?? row.date } : base)
    setErrors({}); setOpen(true)
  }
  function change(field, value) { setDraft(current => ({ ...current, [field]: value })); setErrors(current => ({ ...current, [field]: '' })) }
  async function save(event) {
    event.preventDefault()
    const issues = {}
    if (!draft.date || draft.date > today()) issues.date = '请选择不晚于今天的日期'
    if (draft.kind === 'trade') {
      if (!Number.isInteger(Number(draft.quantity)) || Number(draft.quantity) <= 0) issues.quantity = '请输入大于 0 的整数股数'
      if (!(Number(draft.price) > 0)) issues.price = '请输入大于 0 的成交价'
      if (draft.action === '减仓' && !draft.id && Number(draft.quantity) >= Number(quantity)) issues.quantity = '减仓后需保留持仓；股数必须小于当前持仓'
      if (!String(draft.reason || '').trim()) issues.reason = '请填写成交理由'
    }
    if (draft.kind === 'plan' && !String(draft.judgement || '').trim()) issues.judgement = '请填写交易前判断'
    if (draft.kind === 'review' && !String(draft.conclusion || '').trim()) issues.conclusion = '请填写复盘结论'
    setErrors(issues)
    if (Object.keys(issues).length) return
    setSaving(true)
    try {
      const result = await saveJournal(stockCode, draft)
      await reload()
      if (draft.kind === 'trade' && result.entry.affects_position !== 0) await onHoldingChange?.()
      setExpanded(result.entry.id); setOpen(false)
      toast({ title: draft.kind === 'trade' ? result.entry.affects_position === 0 ? '历史成交已保存，当前持仓未重复调整' : `成交已记录，持仓更新为 ${result.holding.quantity} 股，成本 ${money(result.holding.cost_price)}` : `${draft.kind === 'plan' ? '交易计划' : '复盘'}已保存` })
    } catch (error) { setErrors({ form: error.message || '保存失败，请重试' }) }
    finally { setSaving(false) }
  }
  const previewQty = Number(quantity) + (draft?.action === '减仓' ? -Number(draft?.quantity || 0) : Number(draft?.quantity || 0))
  const previewCost = draft?.action === '加仓' && previewQty > 0
    ? ((Number(quantity) * Number(costPrice)) + Number(draft?.quantity || 0) * Number(draft?.price || 0)) / previewQty
    : Number(costPrice)
  return <>
    <section className="mb-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs uppercase tracking-wider text-muted-foreground">交易计划</p><p className="mt-1 text-xs text-muted-foreground">未来打算 · 只记录判断与触发条件，不改变持仓</p></div><Button variant="outline" size="sm" onClick={() => show('plan')}><Plus className="mr-1 h-3.5 w-3.5" />写计划</Button></div>
      <div className="rounded-lg border border-border bg-card px-4 py-3">{loading ? <p className="py-4 text-center text-xs text-muted-foreground">加载计划中…</p> : loadError ? <div className="py-4 text-center text-xs text-destructive">计划加载失败：{loadError} <Button variant="link" size="sm" onClick={reload}>重试</Button></div> : !plans.length ? <p className="py-4 text-center text-xs text-muted-foreground">还没有交易计划。写下加仓或减仓的触发条件，实际成交后再记录交易。</p> : <div className="space-y-2">{plans.map(plan => <div key={plan.id} className="flex items-start justify-between gap-3 border-b border-border py-2 last:border-b-0"><div><p className="text-sm font-medium">计划{plan.action} · {plan.planned_price || '未设目标价'}</p><p className="mt-1 text-xs text-muted-foreground">{plan.judgement}</p>{plan.planned_position && <p className="mt-1 text-xs text-muted-foreground">目标仓位：{plan.planned_position}</p>}</div><Button variant="link" size="sm" onClick={() => show('plan', plan)}>编辑</Button></div>)}</div>}</div>
    </section>
    <section className="mb-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs uppercase tracking-wider text-muted-foreground">交易记录与复盘</p><p className="mt-1 text-xs text-muted-foreground">已发生的成交会同步调整持仓数量和成本</p></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => show('review')}><ClipboardPenLine className="mr-1 h-3.5 w-3.5" />写复盘</Button><Button size="sm" onClick={() => show('trade')}><Plus className="mr-1 h-3.5 w-3.5" />记录成交</Button></div></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[['累计交易次数', `${trades.length} 次`, ''], ['已实现收益', pricedReductions.length ? money(realized) : '--', reductions.length > pricedReductions.length ? (pricedReductions.length ? '仅统计有成本依据的减仓' : '缺少成交时成本，暂无法计算') : '按减仓价差估算'], ['当前持有天数', days ? `${days} 天` : '--', days ? '按已录入最早成交日' : '待补成交记录'], ['最近一次操作', latest ? `${shortDate(latest.trade_date)} ${latest.action}` : '暂无记录', '']].map(([label, value, hint]) => <div key={label} className="min-h-[82px] rounded-lg border border-border bg-card px-4 py-3"><p className="mb-1 text-xs text-muted-foreground">{label}</p><p className="text-sm font-semibold num">{value}</p>{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}</div>)}</div>
      <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3">{loading ? <p className="py-4 text-center text-xs text-muted-foreground">加载记录中…</p> : loadError ? <p className="py-4 text-center text-xs text-destructive">记录加载失败：{loadError}</p> : !history.length ? <p className="py-4 text-center text-xs text-muted-foreground">还没有成交或复盘记录。成交后请按实际股数和价格登记。</p> : <div className="border-l border-border pl-5">{history.map(row => {
        const linked = trades.find(trade => trade.id === row.linked_trade_id)
        const isOpen = expanded === row.id
        return <div key={row.id} className="relative border-b border-border py-2.5 last:border-b-0"><span className="absolute -left-[25px] top-4 h-2 w-2 rounded-full border-2 border-card bg-primary" /><button type="button" className="flex w-full items-start justify-between gap-3 text-left" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : row.id)}><div className="min-w-0"><p className="text-sm font-medium">{shortDate(row.trade_date)}{row.kind === 'trade' ? `${row.action} ${row.quantity} 股` : '写下复盘'}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{row.kind === 'trade' ? `理由：${row.reason}${row.affects_position === 0 ? ' · 历史记录，不重复计入持仓' : ''}` : row.conclusion}</p></div>{isOpen ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}</button>{isOpen && <div className="mt-3 space-y-1.5 rounded-md bg-muted/50 p-3 text-xs leading-relaxed">{row.kind === 'trade' ? <><Detail label="实际成交" value={`${row.quantity} 股 × ${money(row.price)}`} /><Detail label="成交理由" value={row.reason} />{row.action === '减仓' && row.cost_basis != null && <Detail label="已实现价差收益" value={money((row.price - row.cost_basis) * row.quantity)} />}</> : <><Detail label="复盘范围" value={linked ? `${shortDate(linked.trade_date)} ${linked.action} ${linked.quantity} 股` : '当前持有周期'} /><Detail label="原先判断" value={row.judgement} /><Detail label="实际结果" value={row.result} /><Detail label="复盘结论" value={row.conclusion} /></>}<div className="flex gap-3 pt-2"><Button variant="link" size="sm" onClick={() => show(row.kind, row)}><Pencil className="mr-1 h-3 w-3" />编辑</Button>{row.kind === 'trade' && <Button variant="link" size="sm" onClick={() => show('review', null, row.id)}>针对这笔交易写复盘</Button>}</div></div>}</div>
      })}</div>}</div>
    </section>
    <Dialog open={open} onOpenChange={setOpen}>{draft && <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto"><DialogHeader><DialogTitle>{draft.id ? '编辑' : '新增'}{draft.kind === 'trade' ? '成交记录' : draft.kind === 'plan' ? '交易计划' : '复盘'}</DialogTitle><DialogDescription>{stockName} · {stockCode}；当前持仓 {Number(quantity).toLocaleString('zh-CN')} 股，成本 {money(costPrice || 0)}，参考价 {money(currentPrice || 0)}</DialogDescription></DialogHeader><form onSubmit={save} className="space-y-4">
      {draft.kind !== 'review' && <div className="flex gap-2">{['加仓', '减仓'].map(action => <Button key={action} type="button" size="sm" variant={draft.action === action ? 'default' : 'outline'} onClick={() => change('action', action)}>{action}</Button>)}</div>}
      <Field label={draft.kind === 'plan' ? '计划创建日期' : draft.kind === 'trade' ? '实际成交日期' : '复盘日期'} error={errors.date}><Input type="date" max={today()} value={draft.date} onChange={e => change('date', e.target.value)} /></Field>
      {draft.kind === 'plan' && <><Field label="交易前判断" error={errors.judgement}><textarea className={area} value={draft.judgement || ''} onChange={e => change('judgement', e.target.value)} placeholder="为什么考虑这笔交易？哪些事实会改变判断？" /></Field><div className="grid grid-cols-2 gap-3"><Field label="目标价格 / 触发条件"><Input value={draft.planned_price || ''} onChange={e => change('planned_price', e.target.value)} placeholder="例如 跌至 70 元以下" /></Field><Field label="目标仓位"><Input value={draft.planned_position || ''} onChange={e => change('planned_position', e.target.value)} placeholder="例如 增加 100 股" /></Field></div><p className="text-xs text-muted-foreground">计划保存后不会改变持仓；实际成交时再填写成交记录。</p></>}
      {draft.kind === 'trade' && <><div className="grid grid-cols-2 gap-3"><Field label="实际股数" error={errors.quantity}><Input type="number" min="1" step="1" value={draft.quantity} onChange={e => change('quantity', e.target.value)} placeholder="例如 100" /></Field><Field label="实际成交价（元/股）" error={errors.price}><Input type="number" min="0.001" step="0.001" value={draft.price} onChange={e => change('price', e.target.value)} /></Field></div><Field label="成交理由" error={errors.reason}><textarea className={area} value={draft.reason || ''} onChange={e => change('reason', e.target.value)} placeholder="记录实际操作的原因" /></Field><div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">{draft.affects_position === 0 ? '这笔历史成交不会重复调整当前持仓。' : draft.id ? '修改成交后，将从记录前持仓重新计算当前数量与成本。' : `保存后预计持仓 ${previewQty > 0 ? previewQty : '—'} 股，成本 ${previewQty > 0 ? money(previewCost) : '—'}。`}<p className="mt-1 text-muted-foreground">成交会立即计入当前持仓；已计入持仓的历史成交请勿重复登记。</p></div></>}
      {draft.kind === 'review' && <><Field label="复盘范围"><select className="h-8 w-full rounded-md border border-border bg-muted px-2 text-sm" value={draft.linked_trade_id || ''} onChange={e => change('linked_trade_id', e.target.value)}><option value="">当前持有周期</option>{trades.map(trade => <option key={trade.id} value={trade.id}>{trade.trade_date} · {trade.action} {trade.quantity} 股</option>)}</select></Field><Field label="原先判断"><textarea className={area} value={draft.judgement || ''} onChange={e => change('judgement', e.target.value)} /></Field><Field label="实际结果"><textarea className={area} value={draft.result || ''} onChange={e => change('result', e.target.value)} /></Field><Field label="复盘结论" error={errors.conclusion}><textarea className={area} value={draft.conclusion || ''} onChange={e => change('conclusion', e.target.value)} /></Field></>}
      {errors.form && <p className="text-xs text-destructive">{errors.form}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button><Button type="submit" disabled={saving}>{saving ? '保存中…' : draft.id ? '保存修改' : draft.kind === 'trade' ? '保存成交并更新持仓' : draft.kind === 'plan' ? '保存计划' : '保存复盘'}</Button></DialogFooter>
    </form></DialogContent>}</Dialog>
  </>
}
