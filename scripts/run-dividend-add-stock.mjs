/**
 * 新增个股：在 Node 内读取 prototype/.env 并注入 process.env，再调 get_model + 同步本地 SQLite。
 * 解决 Vite 子进程未带上 TUSHARE_TOKEN / PYTHON_PATH 等与 .env 不一致的问题。
 * 用法: node scripts/run-dividend-add-stock.mjs "<股票代码或简称>"
 * 成功时向 stdout 打印一行 JSON（供 Vite 解析）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalDatabase } from './local-db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function loadEnvFile() {
  const p = path.join(root, '.env')
  if (!fs.existsSync(p)) return {}
  const out = {}
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (v !== '') out[k] = v
  }
  return out
}

function applyEnvToProcess(fileEnv) {
  for (const [k, v] of Object.entries(fileEnv)) {
    process.env[k] = String(v)
  }
}

function expandPythonFromHome(home) {
  const h = String(home || '').trim()
  if (!h) return []
  const found = []
  try {
    const st = fs.statSync(h)
    if (st.isFile() && /\.exe$/i.test(h)) return [h]
    if (!st.isDirectory()) return []
  } catch {
    return []
  }
  const rel = [
    'python.exe',
    'python3.exe',
    path.join('python', 'python.exe'),
    path.join('Scripts', 'python.exe'),
    path.join('runtime', 'python.exe'),
    path.join('venv', 'Scripts', 'python.exe'),
    path.join('.venv', 'Scripts', 'python.exe'),
  ]
  for (const r of rel) {
    const full = path.join(h, r)
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) found.push(full)
    } catch {
      /* */
    }
  }
  try {
    for (const e of fs.readdirSync(h, { withFileTypes: true }).slice(0, 48)) {
      if (!e.isDirectory()) continue
      const full = path.join(h, e.name, 'python.exe')
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) found.push(full)
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
  return [...new Set(found)]
}

function outJson(obj) {
  console.log(JSON.stringify(obj))
}

/** 仅使用 .env 的 PYTHON_PATH（目录或 python.exe），不回退 py/python，避免误用其它安装 */
function pickPython(pyHome) {
  const h = String(pyHome || '').trim()
  if (!h) {
    outJson({
      ok: false,
      error:
        '未设置 PYTHON_PATH。请在 prototype/.env 中设置，例如 PYTHON_PATH=D:\\sofeware\\veighna_studio\\python.exe',
    })
    process.exit(1)
  }
  const exes = expandPythonFromHome(h)
  if (exes.length === 0) {
    outJson({ ok: false, error: `PYTHON_PATH 无效或找不到 python.exe：${h}` })
    process.exit(1)
  }
  return { exe: exes[0], prefix: [] }
}

function parseAddStockJson(stdout) {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find(l => l.startsWith('ADD_STOCK_JSON:'))
  if (!line) throw new Error('Python 未输出 ADD_STOCK_JSON')
  return JSON.parse(line.slice('ADD_STOCK_JSON:'.length))
}

const query = (process.argv[2] || '').trim()
if (!query) {
  outJson({ ok: false, error: '缺少股票参数' })
  process.exit(1)
}

applyEnvToProcess(loadEnvFile())

const nodeBin = String(process.env.NODE_BIN || '')
  .trim()
  .replace(/[/\\]+$/, '')
const basePath = process.env.PATH || process.env.Path || ''
if (nodeBin) process.env.PATH = `${nodeBin}${path.delimiter}${basePath}`

process.env.ADD_STOCK_QUERY = query
process.env.PYTHONUTF8 = process.env.PYTHONUTF8 || '1'
process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING || 'utf-8'

const pyHome = String(process.env.PYTHON_PATH || '').trim()
const { exe: pyExe, prefix } = pickPython(pyHome)
const getModelScript = path.join(root, 'data', 'get_model.py')

const r1 = spawnSync(pyExe, [...prefix, getModelScript, '--add-from-env'], {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
})
let add
try {
  add = parseAddStockJson(r1.stdout || '')
} catch (e) {
  outJson({
    ok: false,
    error: `${e.message}\nexit=${r1.status}\nstderr:\n${(r1.stderr || '').slice(-8000)}\nstdout:\n${(r1.stdout || '').slice(-4000)}`,
  })
  process.exit(1)
}

if (!add.ok) {
  outJson(add)
  process.exit(1)
}

try {
  const localDb = createLocalDatabase()
  localDb.importYearlyDividendsFromCsv({ onlyCode: add.stock_code })
} catch (e) {
  outJson({
    ok: false,
    error: `同步本地 SQLite 失败：${e.message || String(e)}`,
  })
  process.exit(1)
}
outJson({
  ok: true,
  stock_code: add.stock_code,
  stock_name: add.stock_name,
  rows: add.rows,
})
