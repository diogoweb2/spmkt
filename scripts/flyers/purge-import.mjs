// Undo one bad flyer import: deletes a store's flyer records and Review
// entries created in the last N hours (default 24), plus the Storage images of
// those Review entries, and drops any item left with no records at all. Used
// when an import lands wrong (mis-attributed pages, wrong item names) and the
// flyer needs re-importing from scratch — the per-item+store weekly dedupe
// would otherwise block the re-run.
//
// Usage:
//   node scripts/flyers/purge-import.mjs --store "Metro" [--hours 24] [--dry-run]

import { log, loadEnv, openFamilyDoc } from './shared.mjs'

const DRY_RUN = process.argv.includes('--dry-run')
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`))
  return eq ? eq.slice(flag.length + 1) : null
}

const storeName = argValue('--store')
const hours = Number(argValue('--hours')) || 24
if (!storeName) {
  console.error('Usage: node scripts/flyers/purge-import.mjs --store "Metro" [--hours 24] [--dry-run]')
  process.exit(1)
}

const env = loadEnv()
const { db, save } = await openFamilyDoc(env)
if (!db) throw new Error('family db doc not found')

const store = (db.stores ?? []).find((s) => s.name.toLowerCase() === storeName.toLowerCase())
if (!store) {
  console.error(`No store named "${storeName}"`)
  process.exit(1)
}
const since = Date.now() - hours * 3600 * 1000
const itemName = (id) => db.items?.find((i) => i.id === id)?.name ?? '?'

const records = (db.records ?? []).filter((r) => r.source === 'flyer' && r.storeId === store.id && r.ts > since)
const queued = (db.photoQueue ?? []).filter((q) => q.source === 'flyer' && q.storeId === store.id && q.ts > since)

log(`${store.name}: ${records.length} flyer records + ${queued.length} Review entries from the last ${hours}h`)
for (const r of records) log(`  rec  ${itemName(r.itemId)} | ${r.origName ?? ''} $${r.price}/${r.qty}${r.unit} p${r.flyerPage}`)
for (const q of queued) log(`  rev  ${q.itemName} | ${q.origName ?? ''} $${q.price} p${q.flyerPage}`)

if (DRY_RUN) {
  log('dry run — nothing deleted')
  process.exit(0)
}

// Review images live at photos/{uid}/{id}.jpg; missing objects are fine.
const paths = queued.map((q) => q.path).filter(Boolean)
if (paths.length) {
  try {
    const { getStorage } = await import('firebase-admin/storage')
    const bucket = getStorage().bucket('spmkt-cc6fd.firebasestorage.app')
    for (const p of paths) await bucket.file(p).delete({ ignoreNotFound: true })
    log(`deleted ${paths.length} Review image(s) from Storage`)
  } catch (err) {
    log(`Storage cleanup skipped (${err.message})`)
  }
}

const recIds = new Set(records.map((r) => r.id))
const qIds = new Set(queued.map((q) => q.id))
db.records = (db.records ?? []).filter((r) => !recIds.has(r.id))
db.photoQueue = (db.photoQueue ?? []).filter((q) => !qIds.has(q.id))

// Items this import created and nothing else references are now orphans.
const before = db.items?.length ?? 0
db.items = (db.items ?? []).filter((i) => db.records.some((r) => r.itemId === i.id))
const dropped = before - db.items.length

await save(db)
log(`purged ${records.length} records, ${queued.length} Review entries, ${dropped} now-empty item(s)`)
process.exit(0)
