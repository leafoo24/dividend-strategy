/**
 * Legacy seed entrypoint kept for compatibility.
 * The prototype now seeds yearly dividend data from data/stock_dividend.csv into data/local.db.
 */
import { createLocalDatabase } from './local-db.mjs'

try {
  const localDb = createLocalDatabase()
  localDb.importYearlyDividendsFromCsv()
  console.log(JSON.stringify({ ok: true, target: 'data/local.db' }))
} catch (e) {
  console.error(e.message || String(e))
  process.exit(1)
}
