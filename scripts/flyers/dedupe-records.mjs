// Duplicate-price cleanup (BUSINESS_RULES §17): deletes records that are the
// same product, same store, same price and same DAY — the history rows that
// show up twice on a product page with identical text.
//
//   node scripts/flyers/dedupe-records.mjs --dry-run   # list, change nothing
//   node scripts/flyers/dedupe-records.mjs             # delete
//
// Where they came from: the weekly import's dedupe was one flyer record per
// item+store per WEEK, but a hand-cropped deal (§17) is a separate path into
// the same db, so the same ad reached the records twice — once from the
// automatic import, once from the crop. The import is retired, so this is a
// cleanup of what it left behind rather than an ongoing guard; the live guard
// is the image-beats-image-less rule in applyEntry/approveEntry.
//
// Which copy survives, in order: the one with a kept ad image (§17 — an
// illustrated deal is the better card), then the one with more information
// (origName, flyer provenance), then the oldest. Storage images belonging to
// the dropped copies are deleted too, so nothing is orphaned in the bucket.

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv, openFamilyDoc, log } from './shared.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BUCKET = 'spmkt-cc6fd.firebasestorage.app'

const dayOf = (ts) => new Date(ts).toLocaleDateString('en-CA') // local calendar day

// Identity of a "same deal" row: product, store, price and day. Unit and qty
// are in the key too — $7.99/lb and $7.99/500g on the same day are different
// claims about the price, not a duplicate.
const keyOf = (r) => [r.itemId, r.storeId, r.price, r.qty, r.unit, dayOf(r.ts)].join('|')

// Higher score = keep this copy.
function score(r) {
  let s = 0
  if (r.imgPath || r.imgUrl) s += 100 // an illustrated deal is the better card
  if (r.origName) s += 10 // keeps the shelf name
  if (r.flyerPage != null) s += 5 // links to the exact ad page
  if (r.validUntil) s += 2
  return s
}

export async function dedupeRecords(env, { dryRun = false } = {}) {
  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const records = db.records ?? []

  const groups = new Map()
  for (const r of records) {
    const k = keyOf(r)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }

  const drop = []
  for (const [, rs] of groups) {
    if (rs.length < 2) continue
    // Best copy first: score, then oldest as the tie-break (it's the one the
    // rest of the history was already relating to).
    const sorted = [...rs].sort((a, b) => score(b) - score(a) || a.ts - b.ts)
    drop.push(...sorted.slice(1))
  }

  if (!drop.length) {
    log('dedupe: no duplicate records found')
    return 0
  }

  const itemName = (id) => db.items?.find((i) => i.id === id)?.name ?? id
  const storeName = (id) => db.stores?.find((s) => s.id === id)?.name ?? id
  for (const r of drop) {
    log(`  ${dryRun ? 'would drop' : 'drop'} ${itemName(r.itemId)} @ ${storeName(r.storeId)} — $${r.price}/${r.qty}${r.unit} on ${dayOf(r.ts)}${r.imgPath ? ' (has image)' : ''}`)
  }

  if (dryRun) {
    log(`dedupe: dry run — would delete ${drop.length} of ${records.length} records`)
    return drop.length
  }

  const dropIds = new Set(drop.map((r) => r.id))
  db.records = records.filter((r) => !dropIds.has(r.id))
  await save(db)

  // Only now that the db is saved: clean up the images of the dropped copies,
  // and never an image path the surviving records still point at.
  const kept = new Set(db.records.map((r) => r.imgPath).filter(Boolean))
  const paths = [...new Set(drop.map((r) => r.imgPath).filter((p) => p && !kept.has(p)))]
  if (paths.length && existsSync(join(here, 'service-account.json'))) {
    const { getStorage } = await import('firebase-admin/storage')
    const bucket = getStorage().bucket(BUCKET)
    for (const p of paths) await bucket.file(p).delete().catch(() => {})
    log(`dedupe: deleted ${paths.length} orphaned image(s)`)
  }

  log(`dedupe: deleted ${drop.length} duplicate record(s), ${db.records.length} left`)
  return drop.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await dedupeRecords(loadEnv(), { dryRun: process.argv.includes('--dry-run') })
    process.exit(0)
  } catch (err) {
    console.error(`dedupe FAILED: ${err.message}`)
    process.exit(1)
  }
}
