import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTushareClient, latestIndexSnapshot, runSelection, chinaToday } from '../scripts/strategy-data.mjs'
import { createSelectionJob } from '../scripts/strategy-api.mjs'

test('上海日期与指数快照不使用未来日期，不拼接不同快照',()=>{
  assert.equal(chinaToday(new Date('2025-01-01T17:00:00Z')),'20250102')
  const rows=[{trade_date:'20250101',con_code:'A'},{trade_date:'20250102',con_code:'B'},{trade_date:'20250102',con_code:'C'},{trade_date:'20250103',con_code:'D'}]
  assert.deepEqual(latestIndexSnapshot(rows,'20250102',2),{date:'20250102',codes:['B','C']})
  assert.throws(()=>latestIndexSnapshot(rows,'20250101',2),/不完整/)
})
test('异步任务防重复运行，失败不返回旧名单',async()=>{
  let finish,calls=0
  const job=createSelectionJob(()=>{calls++;return new Promise(resolve=>{finish=resolve})})
  job.start();job.start();await new Promise(r=>setImmediate(r))
  assert.equal(calls,1);assert.equal(job.snapshot().status,'running')
  finish({rows:[]});await new Promise(r=>setImmediate(r))
  assert.equal(job.snapshot().status,'completed')
  const failed=createSelectionJob(()=>{throw new Error('权限不足')})
  failed.start();await new Promise(r=>setImmediate(r))
  assert.equal(failed.snapshot().status,'failed');assert.equal(failed.snapshot().result,null)
})
test('Tushare字段映射与缓存、权限错误及截断均明确处理',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'strategy-test-'))
  try {
    let calls=0
    const query=createTushareClient({token:'secret',cacheDir:dir,interval:0,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({code:0,data:{fields:['a'],items:[[4]]}})}}})
    assert.deepEqual(await query('sample'),[{a:4}]);await query('sample');assert.equal(calls,1)
    await assert.rejects(query('sample',{},'',1),/条数上限/)
    const fail=createTushareClient({token:'secret',cacheDir:dir,interval:0,fetchImpl:async()=>({ok:true,json:async()=>({code:2002,msg:'secret 权限不足'})})})
    await assert.rejects(fail('other'),e=>e.message.includes('权限不足')&&!e.message.includes('secret'))
  } finally {await rm(dir,{recursive:true,force:true})}
})
test('全流程用800成分及真实计算选股；有陷阱的候选不能混入',async()=>{
  const dates=Array.from({length:800},(_,i)=>new Date(Date.UTC(2022,0,1+i)).toISOString().slice(0,10).replaceAll('-',''))
  // Synthetic calendar for deterministic integration; response values are fixture data, not product data.
  const asOf=dates.at(-1),codes=Array.from({length:800},(_,i)=>`${String(i+1).padStart(6,'0')}.SZ`)
  const progress=[]
  const query=async(api,p)=>{
    if(api==='trade_cal')return dates.map(cal_date=>({cal_date}))
    if(api==='index_weight')return (p.index_code==='000300.SH'?codes.slice(0,300):codes.slice(300)).map(con_code=>({con_code,trade_date:asOf}))
    if(api==='stock_basic')return codes.map(ts_code=>({ts_code,name:ts_code,market:'主板'}))
    if(api==='suspend_d')return []
    if(api==='index_classify')return Array.from({length:31},(_,i)=>({index_code:String(i),industry_name:'行业'}))
    if(api==='index_member_all')return codes.filter((_,i)=>i%31===Number(p.l1_code)).map(ts_code=>({ts_code,l1_name:'食品饮料',l2_name:'饮料'}))
    if(api==='daily')return codes.map((ts_code,i)=>({ts_code,close:100+Math.sin(dates.indexOf(p.trade_date))*(i+1)/1000,vol:100}))
    if(api==='adj_factor')return codes.map(ts_code=>({ts_code,adj_factor:1}))
    if(api==='daily_basic')return p.ts_code?dates.map(trade_date=>({trade_date,dv_ttm:4,turnover_rate:3})):codes.map((ts_code,i)=>({ts_code,pe_ttm:10,pb:1,dv_ttm:i<2?5:1}))
    if(api==='income'||api==='fina_indicator'||api==='cashflow')return ['20231231','20221231','20211231'].map(end_date=>({end_date,ann_date:'20240201',report_type:'1',n_income_attr_p:1000000,profit_dedt:900000,n_cashflow_act:800000}))
    if(api==='dividend')return ['20231231','20221231','20211231'].map(end_date=>({end_date,imp_ann_date:'20240201',ex_date:'20240202',div_proc:'实施',cash_div_tax:p.ts_code===codes[1]?2:0.5,base_share:100,stk_div:0}))
    throw new Error(api)
  }
  const result=await runSelection({query,today:'20240311',progress:p=>progress.push(p)})
  assert.equal(result.stats.universe,800)
  assert.equal(result.rows.length,1)
  assert.equal(result.rows[0].code,codes[0])
  assert.equal(result.rows[0].payout,0.5)
  assert.equal(result.rows[0].avgDv,0.04)
  assert.ok(progress.length>60)
})
