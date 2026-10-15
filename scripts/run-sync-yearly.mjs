/**
 * Sync data/stock_dividend.csv into the local SQLite database.
 * Usage: node scripts/run-sync-yearly.mjs [--only 600900]
 */
import { createLocalDatabase } from './local-db.mjs'

const args = process.argv.slice(2)
const onlyIndex = args.indexOf('--only')
const onlyCode = onlyIndex >= 0 ? args[onlyIndex + 1] : null

try {
  const localDb = createLocalDatabase()
  localDb.importYearlyDividendsFromCsv(onlyCode ? { onlyCode } : {})
  console.log(JSON.stringify({ ok: true, target: 'data/local.db', onlyCode }))
} catch (e) {
  console.error(e.message || String(e))
  process.exit(1)
}
