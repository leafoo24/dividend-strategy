import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { number, visibleReports, ttm, annualDividends, average, volatility, evaluate, rankRows } from './strategy-engine.mjs'

export const STRATEGY_VERSION = 'quality-dividend-v1'
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms))
export function chinaToday(now=new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','')
}
function daysBefore(ymd,days) {
  const d=new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate()-days)
  return d.toISOString().slice(0,10).replaceAll('-','')
}
export function createTushareClient({token,cacheDir,fetchImpl=fetch,interval=360}) {
  let last=0
  return async function query(api,params={},fields='',cap=6000) {
    if (!token) throw new Error('未配置 TUSHARE_TOKEN，请在系统服务器环境中配置。')
    const key=createHash('sha256').update(JSON.stringify({api,params,fields})).digest('hex')
    const file=path.join(cacheDir,`${key}.json`)
    try {
      const cached=JSON.parse(await readFile(file,'utf8'))
      if(Date.now()-cached.time<12*3600000 && Array.isArray(cached.rows) && cached.rows.length<cap) return cached.rows
    } catch {}
    for(let attempt=0;attempt<3;attempt++) {
      await delay(Math.max(0,interval-(Date.now()-last)));last=Date.now()
      const res=await fetchImpl('https://api.tushare.pro',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_name:api,token,params,fields}),signal:AbortSignal.timeout(45000)})
      if(!res.ok) throw new Error(`${api} 请求失败（HTTP ${res.status}）`)
      const json=await res.json()
      if(json.code!==0) {
        if(/每分钟|频率|频次/.test(json.msg||'')&&attempt<2) {await delay(20000);continue}
        throw new Error(`${api}：${String(json.msg||'数据服务异常').replaceAll(token,'[已隐藏]')}`)
      }
      if(!Array.isArray(json.data?.fields)||!Array.isArray(json.data?.items)) throw new Error(`${api} 返回数据格式异常`)
      const rows=json.data.items.map(values=>Object.fromEntries(json.data.fields.map((field,i)=>[field,values[i]])))
      if(rows.length>=cap) throw new Error(`${api} 返回达到条数上限，停止选股以避免使用截断数据。`)
      await mkdir(cacheDir,{recursive:true})
      await writeFile(file,JSON.stringify({time:Date.now(),rows}),'utf8')
      return rows
    }
  }
}

export function latestIndexSnapshot(rows,asOf,expected) {
  const date=rows.filter(x=>x.trade_date<=asOf).map(x=>x.trade_date).sort().at(-1)
  const codes=[...new Set(rows.filter(x=>x.trade_date===date).map(x=>x.con_code))]
  if(!date||codes.length!==expected) throw new Error(`指数成分不完整：期望${expected}只，实际${codes.length}只。`)
  return {date,codes}
}

export async function runSelection({query,progress=()=>{},today=chinaToday()}) {
  const stats={universe:0,basicPassed:0,evaluated:0,missing:0,rejected:0}
  const omissions=[]
  const emit=(message,completed=0,total=0)=>progress({message,completed,total,stats:{...stats}})
  emit('确定最近完整交易日')
  const calendar=await query('trade_cal',{exchange:'SSE',start_date:daysBefore(today,1600),end_date:daysBefore(today,1),is_open:'1'},'cal_date,is_open')
  const dates=[...new Set(calendar.map(x=>x.cal_date))].sort()
  if(dates.length<750) throw new Error('交易日历不足750日，无法计算三年平均股息率。')
  const asOf=dates.at(-1), last61=dates.slice(-61), last750=dates.slice(-750)
  const old=daysBefore(asOf,1600)
  const snapshots=[]
  for(const [index,expected] of [['000300.SH',300],['000905.SH',500]]) {
    emit(`读取${index==='000300.SH'?'沪深300':'中证500'}成分`)
    const data=await query('index_weight',{index_code:index,start_date:daysBefore(asOf,100),end_date:asOf},'index_code,con_code,trade_date,weight',100000)
    snapshots.push({...latestIndexSnapshot(data,asOf,expected),index})
  }
  const codes=[...new Set(snapshots.flatMap(x=>x.codes))].sort();stats.universe=codes.length
  emit('读取股票资料、估值与停牌状态')
  const stocks=await query('stock_basic',{list_status:'L'},'ts_code,name,market,list_date',10000)
  const basic=await query('daily_basic',{trade_date:asOf},'ts_code,trade_date,pe_ttm,pb,dv_ttm,turnover_rate')
  if(basic.length<codes.length) throw new Error('基准日估值数据尚未完整，请稍后重试。')
  const suspends=await query('suspend_d',{trade_date:today,suspend_type:'S'},'ts_code,suspend_type')
  // Names are current, consistent with this latest-only screener. No historical-date UI.
  const stockMap=new Map(stocks.map(x=>[x.ts_code,x])), basicMap=new Map(basic.map(x=>[x.ts_code,x]))
  const suspended=new Set(suspends.map(x=>x.ts_code))
  emit('读取申万行业归属')
  const classes=await query('index_classify',{level:'L1',src:'SW2021'},'index_code,industry_name')
  if(classes.length<25) throw new Error('申万行业分类数据不完整。')
  const industryMap=new Map()
  for(const cls of classes) {
    const members=await query('index_member_all',{l1_code:cls.index_code,is_new:'Y'},'ts_code,l1_name,l2_name,in_date,out_date',2000)
    if(!members.length) throw new Error(`${cls.industry_name}行业成分为空，无法可靠排除行业。`)
    for(const m of members) industryMap.set(m.ts_code,m)
  }
  const universe=codes.filter(code=>{
    const s=stockMap.get(code),ind=industryMap.get(code)
    if(!s||!ind) {stats.missing++;omissions.push({code,reason:'缺少股票资料或申万行业'});return false}
    return !/ST|退/i.test(s.name) && s.market!=='科创板' && !code.startsWith('688') && !suspended.has(code) && !['建筑装饰','房地产'].includes(ind.l1_name)
  })
  // Rank volatility in the entire eligible base pool, before valuation and dividend filters.
  const priceMap=new Map(universe.map(c=>[c,[]]))
  for(let i=0;i<last61.length;i++) {
    const date=last61[i];emit('计算股票池60日波动率',i+1,last61.length)
    const daily=await query('daily',{trade_date:date},'ts_code,close,vol')
    const factors=await query('adj_factor',{trade_date:date},'ts_code,adj_factor')
    if(!daily.length||!factors.length) throw new Error(`${date}行情或复权因子缺失。`)
    const fm=new Map(factors.map(x=>[x.ts_code,number(x.adj_factor)]))
    const dm=new Map(daily.map(x=>[x.ts_code,x]))
    for(const code of universe) {
      const r=dm.get(code),f=fm.get(code),close=number(r?.close)
      // Suspended days are not filled forward: this conservative version excludes incomplete windows.
      priceMap.get(code).push(close>0&&f>0 ? close*f : null)
    }
  }
  const vols=universe.map(code=>({code,value:volatility(priceMap.get(code))}))
  const validVols=vols.filter(x=>x.value!=null).sort((a,b)=>a.value-b.value||a.code.localeCompare(b.code))
  const volMap=new Map(validVols.map(x=>[x.code,{volatility:x.value,volatilityPercentile:validVols.filter(v=>v.value<=x.value).length/validVols.length}]))
  const candidates=[]
  for(const code of universe) {
    const b=basicMap.get(code),v=volMap.get(code)
    if(!b||!v||[b.pe_ttm,b.pb,b.dv_ttm].some(x=>number(x)==null)) {stats.missing++;continue}
    if(number(b.pe_ttm)>0&&number(b.pe_ttm)<=25&&number(b.pb)>0&&number(b.dv_ttm)>3&&v.volatilityPercentile<=0.9) candidates.push(code)
  }
  stats.basicPassed=candidates.length
  const selected=[]
  for(let i=0;i<candidates.length;i++) {
    const code=candidates[i],s=stockMap.get(code),b=basicMap.get(code),ind=industryMap.get(code)
    emit(`核对 ${s.name} 的股息与盈利质量`,i+1,candidates.length)
    const history=await query('daily_basic',{ts_code:code,start_date:last750[0],end_date:asOf},'trade_date,dv_ttm,turnover_rate')
    const hm=new Map(history.map(x=>[x.trade_date,x]))
    const avgDv=average(last750.map(d=>number(hm.get(d)?.dv_ttm)),750)
    const turnover20=average(dates.slice(-20).map(d=>hm.get(d)?.turnover_rate),20)
    stats.evaluated++
    if(avgDv==null||turnover20==null) {stats.missing++;omissions.push({code,name:s.name,reason:'股息率750日或换手率20日数据不足'});continue}
    if(avgDv<=2.5||turnover20<=2) {stats.rejected++;continue}
    const income=await query('income',{ts_code:code,start_date:old,end_date:asOf,report_type:'1'},'end_date,ann_date,f_ann_date,report_type,n_income_attr_p,update_flag',1000)
    const indicators=await query('fina_indicator',{ts_code:code,start_date:old,end_date:asOf},'end_date,ann_date,profit_dedt,update_flag',100)
    const financial=['银行','非银金融'].includes(ind.l1_name)
    const cf=financial?[]:await query('cashflow',{ts_code:code,start_date:old,end_date:asOf,report_type:'1'},'end_date,ann_date,f_ann_date,report_type,n_cashflow_act,update_flag',1000)
    const divs=await query('dividend',{ts_code:code},'end_date,ann_date,imp_ann_date,div_proc,cash_div_tax,base_share,ex_date,record_date,stk_div',2000)
    const im=visibleReports(income,asOf),fm=visibleReports(indicators,asOf)
    const period=[...im.keys()].sort().at(-1)
    const annual=[...im.keys()].filter(x=>x.endsWith('1231')).sort().at(-1)
    if(!annual||!period||period<daysBefore(asOf,400)||Number(annual.slice(0,4))<Number(asOf.slice(0,4))-2) {stats.missing++;omissions.push({code,name:s.name,reason:'财报缺失或过期'});continue}
    const year=Number(annual.slice(0,4)),years=[year,year-1,year-2]
    const dividends=annualDividends(divs,year,asOf)
    const metrics=evaluate({code,name:s.name,industry:ind.l1_name,industry2:ind.l2_name,financial,asOf,period,annualYears:years,
      pe:number(b.pe_ttm),pb:number(b.pb),dv:number(b.dv_ttm)/100,avgDv:avgDv/100,turnover20,...volMap.get(code),
      annualProfit:years.map(y=>number(im.get(`${y}1231`)?.n_income_attr_p)),annualDeducted:years.map(y=>number(fm.get(`${y}1231`)?.profit_dedt)),
      annualCash:dividends.map(d=>d.cash),dps:dividends.map(d=>d.dps),splitAffected:dividends.slice(0,2).some(d=>d.split),
      profitTtm:ttm(income,'n_income_attr_p',asOf,period),deductedTtm:ttm(indicators,'profit_dedt',asOf,period),ocfTtm:financial?null:ttm(cf,'n_cashflow_act',asOf,period)})
    if(metrics.passed) selected.push(metrics)
    else if(metrics.missing.length) {stats.missing++;omissions.push({code,name:s.name,reason:metrics.missing.join('、')})}
    else stats.rejected++
  }
  return {version:STRATEGY_VERSION,asOf,screenedAt:new Date().toISOString(),industryStandard:'申万2021（当前归属）',snapshots:snapshots.map(({index,date})=>({index,date})),stats,omissions,rows:rankRows(selected)}
}
