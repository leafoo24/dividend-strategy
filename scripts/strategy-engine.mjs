// Pure calculations. Ratios are decimal; turnover is percentage points; amounts are yuan.
export function number(value) {
  if (value == null || String(value).trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
export function visibleReports(rows, asOf) {
  const result = new Map()
  for (const r of rows) {
    const announced = r.f_ann_date || r.ann_date
    if (!announced || announced > asOf || !r.end_date || r.end_date > asOf) continue
    // Consolidated cumulative statements, including adjusted versions.
    if (r.report_type != null && !['1','4','5'].includes(String(r.report_type))) continue
    const prior = result.get(r.end_date)
    if (!prior || announced > (prior.f_ann_date || prior.ann_date) || (announced === (prior.f_ann_date || prior.ann_date) && String(r.update_flag) === '1')) result.set(r.end_date, r)
  }
  return result
}
export function ttm(rows, field, asOf, period) {
  const map = visibleReports(rows, asOf)
  const end = period || [...map.keys()].sort().at(-1)
  if (!end) return null
  const current = number(map.get(end)?.[field])
  if (current == null || end.endsWith('1231')) return current
  const year = Number(end.slice(0,4))-1
  const annual = number(map.get(`${year}1231`)?.[field])
  const previous = number(map.get(`${year}${end.slice(4)}`)?.[field])
  return annual == null || previous == null ? null : current + annual - previous
}
export function average(values, length) {
  const window = values.slice(-length).map(number)
  return window.length !== length || window.some(x=>x==null) ? null : window.reduce((a,b)=>a+b,0)/length
}
export function volatility(prices) {
  const p = prices.slice(-61).map(number)
  if (p.length !== 61 || p.some(x=>x==null || x<=0)) return null
  const returns = p.slice(1).map((x,i)=>x/p[i]-1)
  const mean = average(returns,60)
  return Math.sqrt(returns.reduce((s,r)=>s+(r-mean)**2,0)/59)*Math.sqrt(250)
}
export function annualDividends(rows, year, asOf) {
  const seen = new Set()
  const result = [year,year-1,year-2].map(year=>({year,cash:0,dps:0,split:false}))
  for (const r of rows) {
    const announced = r.imp_ann_date || r.ann_date
    if (r.div_proc !== '实施' || !announced || announced>asOf || !r.ex_date || r.ex_date>asOf) continue
    const group = result.find(x=>x.year===Number(String(r.end_date).slice(0,4)))
    if (!group) continue
    const key = `${r.end_date}|${r.ex_date}|${r.record_date || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const dps = number(r.cash_div_tax)
    const shares = number(r.base_share)
    group.split ||= (number(r.stk_div) || 0)>0
    if (dps==null || dps<0) {group.cash=null;group.dps=null;continue}
    if (group.dps!=null) group.dps+=dps
    if (group.cash!=null && dps>0) group.cash=shares!=null && shares>0 ? group.cash+dps*shares*10000 : null
  }
  return result
}
export function evaluate(m) {
  const missing=[];const failed=[]
  const check=(label,value,predicate)=>{
    if (number(value)==null) missing.push(label)
    else if (!predicate(value)) failed.push(label)
  }
  check('PE TTM',m.pe,x=>x>0&&x<=25)
  check('PB',m.pb,x=>x>0)
  check('股息率TTM',m.dv,x=>x>0.03)
  check('750日平均股息率',m.avgDv,x=>x>0.025)
  check('60日波动率',m.volatility,x=>x>=0)
  check('波动率分位',m.volatilityPercentile,x=>x<=0.9)
  check('20日日均换手率',m.turnover20,x=>x>2)
  for(let i=0;i<3;i++) {
    check(`${i}年前归母净利润`,m.annualProfit?.[i],x=>x>0)
    check(`${i}年前扣非归母净利润`,m.annualDeducted?.[i],x=>x>0)
    check(`${i}年前现金分红`,m.annualCash?.[i],x=>x>0)
  }
  check('归母净利润TTM',m.profitTtm,x=>x>0)
  check('扣非归母净利润TTM',m.deductedTtm,x=>x>0)
  const ratio = (a,b)=>number(a)!=null && number(b)!=null && b>0 ? a/b : null
  const sum=a=>a?.length===3 && a.every(x=>number(x)!=null) ? a.reduce((s,x)=>s+Number(x),0) : null
  const payout=ratio(m.annualCash?.[0],m.annualProfit?.[0])
  const payout3=ratio(sum(m.annualCash),sum(m.annualProfit))
  check('最近年度支付率',payout,x=>x>0&&x<=1)
  check('三年累计支付率',payout3,x=>x>0&&x<=1)
  check('最新年度每股分红',m.dps?.[0],x=>x>0)
  check('上年度每股分红',m.dps?.[1],x=>x>0)
  if (m.splitAffected) missing.push('送转股影响每股分红可比性')
  else if (number(m.dps?.[0])!=null && number(m.dps?.[1])!=null && m.dps[0]+1e-10<m.dps[1]) failed.push('每股分红下降')
  const cashCoverage=ratio(m.ocfTtm,m.profitTtm)
  if (!m.financial) check('经营现金流覆盖',cashCoverage,x=>x>0.5)
  const score=number(m.dv)!=null&&number(m.volatility)!=null ? m.dv*(1-0.3*m.volatility) : null
  return {...m,payout,payout3,cashCoverage,score,consecutiveYears:(m.annualCash||[]).findIndex(x=>!(x>0))===-1 ? 3 : (m.annualCash||[]).findIndex(x=>!(x>0)),missing,failed,passed:missing.length===0&&failed.length===0}
}
export function rankRows(rows) {
  return [...rows].sort((a,b)=>b.score-a.score||a.code.localeCompare(b.code)).map((r,i)=>({...r,rank:i+1}))
}
