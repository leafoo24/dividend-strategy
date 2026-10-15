import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTushareClient, runSelection } from './strategy-data.mjs'

export function createSelectionJob(run) {
  let state={status:'idle',message:'尚未运行',result:null}
  return {
    snapshot:()=>structuredClone(state),
    start() {
      if(state.status==='running') return this.snapshot()
      state={status:'running',message:'准备读取行情数据',startedAt:new Date().toISOString(),result:null,completed:0,total:0}
      Promise.resolve().then(()=>run(update=>{state={...state,...update}})).then(result=>{
        state={...state,status:'completed',message:'选股完成',result,finishedAt:new Date().toISOString()}
      }).catch(error=>{state={...state,status:'failed',message:error.message||'选股失败',result:null}})
      return this.snapshot()
    },
  }
}
export function strategyApiPlugin(env={}) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
  const query=createTushareClient({token:String(env.TUSHARE_TOKEN||process.env.TUSHARE_TOKEN||'').trim(),cacheDir:path.join(root,'data','strategy-cache')})
  const job=createSelectionJob(progress=>runSelection({query,progress}))
  function install(server) {
    server.middlewares.use((req,res,next)=>{
      if(req.url?.split('?')[0]!=='/api/strategy-selection') return next()
      res.setHeader('Content-Type','application/json; charset=utf-8')
      res.setHeader('Cache-Control','no-store')
      if(req.method==='GET') {res.end(JSON.stringify(job.snapshot()));return}
      if(req.method==='POST') {res.statusCode=202;res.end(JSON.stringify(job.start()));return}
      res.statusCode=405;res.end(JSON.stringify({error:'不支持的请求方法'}))
    })
  }
  return {name:'strategy-selection-api',configureServer:install,configurePreviewServer:install}
}
