// One-off: add flyerUrl to flyer records imported before the app stored it,
// matching each record's store name to its stores.json URL. No page number is
// known for old records, so their 📰 badge links to the flyer's first page.
//
//   node scripts/flyers/backfill-flyer-url.mjs [--dry-run]

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log, loadEnv, openFamilyDoc } from './shared.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
const stores = JSON.parse(readFileSync(join(here, 'stores.json'), 'utf8'))

const env = loadEnv()
const { db, save } = await openFamilyDoc(env)
if (!db) throw new Error('family db doc not found')

const urlByStoreId = new Map()
for (const s of db.stores ?? []) {
  const cfg = stores.find((c) => c.name.toLowerCase() === s.name.toLowerCase())
  if (cfg) urlByStoreId.set(s.id, cfg.url)
}

let updated = 0
for (const r of db.records ?? []) {
  if (r.source !== 'flyer' || r.flyerUrl) continue
  const url = urlByStoreId.get(r.storeId)
  if (!url) continue
  r.flyerUrl = url
  updated++
}
log(`${updated} flyer records backfilled with flyerUrl${DRY_RUN ? ' (dry run, not saved)' : ''}`)
if (!DRY_RUN && updated) await save(db)
