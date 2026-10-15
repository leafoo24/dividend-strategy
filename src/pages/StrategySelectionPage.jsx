import { useEffect, useRef, useState } from 'react'
import { Search, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getJson, postJson } from '@/lib/localApi'

const format=(v,digits=2)=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits})
const pct=v=>v==null?'—':`${format(v*100)}%`
const money=v=>v==null?'—':format(v/1e8)
const date=v=>v?`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`:'—'
const columns=[
  ['行业',r=>r.industry],['二级行业',r=>r.industry2],['策略得分',r=>format(r.score,5)],
  ['股息率TTM',r=>pct(r.dv),'>3%'],['750日平均股息率',r=>pct(r.avgDv),'>2.5%'],
  ['PE TTM',r=>format(r.pe),'0<PE≤25'],['PB',r=>format(r.pb),'>0'],
  ['60日年化波动率',r=>pct(r.volatility)],['波动率分位',r=>pct(r.volatilityPercentile),'保留最低90%'],
  ['20日日均换手率',r=>`${format(r.turnover20)}%`,'>2%'],['连续分红年数',r=>r.consecutiveYears,'3年'],
  ['最近年度支付率',r=>pct(r.payout),'0<支付率≤100%'],['三年累计支付率',r=>pct(r.payout3),'0<支付率≤100%'],
  ['现金流／归母利润TTM',r=>r.financial?'不适用（金融业）':format(r.cashCoverage),'>0.5；金融业豁免'],
  ['归母净利润TTM（亿元）',r=>money(r.profitTtm),'>0'],['扣非归母利润TTM（亿元）',r=>money(r.deductedTtm),'>0'],
  ['经营现金流TTM（亿元）',r=>r.financial?'不适用（金融业）':money(r.ocfTtm)],['TTM报告期',r=>date(r.period)],
  ...[0,1,2].flatMap(i=>[
    [`${i===0?'最近':`前移${i}年`}年报年度`,r=>r.annualYears[i]],
    [`归母净利润${i}（亿元）`,r=>money(r.annualProfit[i]),'>0'],
    [`扣非归母利润${i}（亿元）`,r=>money(r.annualDeducted[i]),'>0'],
    [`现金分红${i}（亿元）`,r=>money(r.annualCash[i]),'>0'],
    [`每股现金分红${i}（元）`,r=>format(r.dps[i],4),i===0?'不低于上一年度':''],
  ]),
]

export default function StrategySelectionPage() {
  const [job,setJob]=useState({status:'idle'})
  const [error,setError]=useState('')
  const [starting,setStarting]=useState(false)
  const alive=useRef(true)
  useEffect(()=>{
    alive.current=true
    let timer
    let stopped=false
    async function poll() {
      try {const state=await getJson('/api/strategy-selection');if(!stopped){setJob(state);setError('')}}
      catch(e){if(!stopped)setError(`无法读取选股状态：${e.message}`)}
      if(!stopped)timer=setTimeout(poll,2500)
    }
    poll()
    return()=>{stopped=true;alive.current=false;clearTimeout(timer)}
  },[])
  async function select() {
    setStarting(true);setError('')
    try {const state=await postJson('/api/strategy-selection');if(alive.current)setJob(state)}
    catch(e){if(alive.current)setError(e.message)}
    finally{if(alive.current)setStarting(false)}
  }
  const running=job.status==='running'||starting
  const result=job.result
  return <div className="p-6 space-y-5">
    <div className="flex items-center justify-between gap-4">
      <div><h1 className="text-xl font-semibold">策略选股</h1><p className="text-sm text-muted-foreground mt-1">中证800 · 高股息低波动 · 分红质量增强</p></div>
      <Button onClick={select} disabled={running} className="min-w-28">{running?<Loader2 className="w-4 h-4 mr-2 animate-spin"/>:<Search className="w-4 h-4 mr-2"/>}{running?'选股中':'选股'}</Button>
    </div>
    <div className="rounded-lg border border-border bg-card p-4 text-sm space-y-2">
      <p>股息率TTM &gt; 3% · 750日平均 &gt; 2.5% · 连续三年分红 · 扣非盈利为正 · 分红有利润覆盖 · 每股分红不下降</p>
      <p className="text-xs text-muted-foreground leading-6">排除建筑装饰、房地产、ST、科创板和停牌股票。通过筛选后，按「股息率TTM ×（1 − 0.3 × 60日年化波动率）」降序排列。不限制结果数量，不自动放宽条件。</p>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看固定策略与数据口径</summary>
        <div className="mt-3 leading-6 space-y-1">
          <p>PE采用TTM，范围(0,25]；PB&gt;0；20日换手率采用日均值&gt;2%。60日波动率为复权简单日收益样本标准差×√250，分位在排除行业、ST、科创板及停牌后的基础股票池中计算，保留最低90%。</p>
          <p>最近三个已披露年报年度，归母及扣非归母利润逐年&gt;0，最新TTM两项也须&gt;0；最近年度、三年累计现金分红／对应归母利润均在(0,100%]。现金分红只计截至基准日已实施且已除息的方案，按分红所属年度归集。每股分红比较年度发生送转时暂按数据不足排除。</p>
          <p>非金融企业经营现金流TTM／归母净利润TTM&gt;0.5；银行、非银金融该条件不适用，其余质量条件仍执行。未纳入口径待确认的“归母增长&gt;1%”。</p>
          <p>使用上一完整交易日行情及当时已披露财报、最近指数成分快照、当前申万2021行业与股票状态；与果仁申万2014不完全相同。本页为当前选股，不是14:50回测。750日窗口或必要财务值缺失均不入选，不填造数据。</p>
        </div>
      </details>
    </div>
    {(error||job.status==='failed')&&<div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5"/><div><p>选股未完成</p><p className="mt-1">{error||job.message}</p><p className="mt-1 text-xs">未生成候选名单。请检查数据服务或权限后重新点击选股。</p></div></div>}
    {running&&<div role="status" className="rounded-lg border border-border bg-card p-4 space-y-3"><div className="flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin text-primary"/>{job.message||'正在启动选股'}</div>{job.total>0&&<><progress aria-label="当前阶段进度" value={job.completed||0} max={job.total} className="w-full h-2 accent-teal-600"/><p className="text-xs text-muted-foreground">当前阶段 {job.completed} / {job.total}</p></>}<p className="text-xs text-muted-foreground">首次运行需要下载历史数据，可能耗时数分钟；后续运行会复用缓存。切换页面不会中断任务。</p></div>}
    {result&&job.status==='completed'&&<>
      <div role="status" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"><span className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4 text-primary"/>筛选出 {result.rows.length} 只股票</span><span className="text-muted-foreground">行情基准日 {date(result.asOf)}</span><span className="text-muted-foreground">股票池 {result.stats.universe} 只 · 进入股息质量检查 {result.stats.basicPassed} 只 · 数据不足 {result.stats.missing} 只</span></div>
      {result.stats.missing>0&&<p className="text-xs text-amber-700">有 {result.stats.missing} 只股票因必要数据不足被排除，本次结果可能不完整。</p>}
      {result.rows.length>0?<div className="rounded-lg border border-border bg-card overflow-auto max-h-[65vh]">
        <table className="w-full text-xs whitespace-nowrap num"><thead className="sticky top-0 z-20 bg-muted"><tr><th className="px-3 py-3 text-left">排名</th><th className="sticky left-0 z-30 bg-muted px-4 py-3 text-left min-w-36">股票名称</th>{columns.map(([label,,rule])=><th key={label} title={rule||label} className="px-4 py-3 text-right font-medium"><div>{label}</div>{rule&&<div className="text-[10px] text-muted-foreground font-normal mt-1">{rule}</div>}</th>)}</tr></thead>
          <tbody>{result.rows.map(r=><tr key={r.code} className="border-t border-border hover:bg-muted/30"><td className="px-3 py-3 text-muted-foreground">{r.rank}</td><td className="sticky left-0 bg-card px-4 py-3"><div className="font-medium">{r.name}</div><div className="text-muted-foreground mt-1">{r.code}</div></td>{columns.map(([label,render])=><td key={label} className="px-4 py-3 text-right">{render(r)}</td>)}</tr>)}</tbody>
        </table>
      </div>:<div className="rounded-lg border border-dashed border-border p-12 text-center"><p className="font-medium">本次没有股票满足全部条件</p><p className="text-sm text-muted-foreground mt-2">已按固定策略完成筛选，没有降低门槛或补入其他股票。</p></div>}
      <p className="text-xs text-muted-foreground">表格可横向滚动查看全部子指标。年度指标0、1、2分别对应各行列明的最近年报年度及前移年度。指数快照：{result.snapshots.map(x=>`${x.index} ${date(x.date)}`).join('；')}。</p>
    </>}
    {job.status==='idle'&&!error&&<div className="rounded-lg border border-dashed border-border py-20 text-center"><Search className="h-8 w-8 mx-auto text-muted-foreground/50 mb-4"/><p className="font-medium">点击“选股”，生成候选股票列表</p><p className="text-sm text-muted-foreground mt-2">结果展示所有筛选子指标及排序得分。</p></div>}
  </div>
}
