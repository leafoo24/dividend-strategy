import test from 'node:test'
import assert from 'node:assert/strict'
import { number, ttm, annualDividends, evaluate, volatility, average, rankRows } from '../scripts/strategy-engine.mjs'

test('缺失和空串不能被转换为有效零值', () => {
  for (const v of [null, undefined, '', ' ', Infinity]) assert.equal(number(v), null)
  assert.equal(number('0'), 0)
})
test('累计财报转TTM并排除未来公告与错误报表类型', () => {
  const rows = [
    {end_date:'20250630',ann_date:'20250801',x:40,report_type:'1'},
    {end_date:'20241231',ann_date:'20250301',x:100,report_type:'1'},
    {end_date:'20240630',ann_date:'20240801',x:30,report_type:'1'},
    {end_date:'20250630',ann_date:'20260901',x:400,report_type:'1'},
    {end_date:'20250630',ann_date:'20250802',x:800,report_type:'2'},
  ]
  assert.equal(ttm(rows, 'x', '20250820', '20250630'), 110)
  assert.equal(ttm(rows.slice(0,2), 'x', '20250820', '20250630'), null)
})
test('分红按所属年度归集、排除预案未来派现并去重', () => {
  const r = {end_date:'20241231',imp_ann_date:'20250501',ex_date:'20250510',div_proc:'实施',cash_div_tax:0.5,base_share:100,stk_div:0}
  const result = annualDividends([r,r,{...r,div_proc:'预案'},{...r,ex_date:'20260601'}], 2024, '20250601')
  assert.equal(result[0].cash, 500000)
  assert.equal(result[0].dps, 0.5)
  assert.equal(result[1].cash, 0)
})
const good = () => ({pe:10,pb:1,dv:0.05,avgDv:0.04,volatility:0.2,volatilityPercentile:0.5,turnover20:2.5,annualYears:[2024,2023,2022],annualProfit:[100,100,100],annualDeducted:[90,90,90],annualCash:[60,60,60],dps:[0.6,0.5,0.4],deductedTtm:90,profitTtm:100,ocfTtm:80,splitAffected:false,financial:false})
test('合格股评分以小数比例计算，所有质量条件必须满足', () => {
  assert.equal(evaluate(good()).passed, true)
  assert.ok(Math.abs(evaluate(good()).score - 0.047)<1e-10)
  for (const overrides of [{annualCash:[60,0,60]},{annualProfit:[0,100,100]},{annualDeducted:[90,-1,90]},{deductedTtm:0},{dps:[0.4,0.5,0.4]},{annualCash:[110,60,60]},{ocfTtm:50},{avgDv:null},{splitAffected:true}]) assert.equal(evaluate({...good(),...overrides}).passed,false)
})
test('金融行业现金流不适用，但仍必须通过其他质量条件', () => {
  assert.equal(evaluate({...good(),financial:true,ocfTtm:null}).passed,true)
  assert.equal(evaluate({...good(),financial:true,deductedTtm:-1}).passed,false)
})
test('均值要求完整窗口，波动使用60个有效日收益', () => {
  assert.equal(average([3,null,4],3),null)
  assert.equal(average([3,4],3),null)
  assert.equal(volatility(Array(60).fill(100)),null)
  assert.equal(volatility(Array(61).fill(100)),0)
})
test('排名按得分降序且同分按股票代码稳定排序', () => {
  assert.deepEqual(rankRows([{code:'B',score:1},{code:'A',score:1},{code:'C',score:2}]).map(x=>[x.code,x.rank]),[['C',1],['A',2],['B',3]])
})
