// One-off: give flyer records with no validUntil the end of the flyer week they
// were cropped in. A null validUntil means "manual entry, never expires" (§10),
// so crops taken off a flyer page with no "Valid from …" line (the upcoming
// flyer before it is published, which serves the current week's pages) became
// deals that show as current forever. loadFlyer() no longer produces null;
// this cleans up the records made before that fix.
//
//   node scripts/flyers/backfill-flyer-validuntil.mjs [--dry-run]

import { log, loadEnv, openFamilyDoc } from './shared.mjs'
import { flyerWeekEnd } from '../../src/lib/flyers.js'

const DRY_RUN = process.argv.includes('--dry-run')

const { db, save } = await openFamilyDoc(loadEnv())
if (!db) throw new Error('family db doc not found')

const storeName = new Map((db.stores ?? []).map((s) => [s.id, s.name]))
const itemName = new Map((db.items ?? []).map((i) => [i.id, i.name]))

let updated = 0
for (const r of db.records ?? []) {
  if (r.source !== 'flyer' || r.validUntil != null) continue
  r.validUntil = flyerWeekEnd(r.ts)
  updated++
  log(`  ${storeName.get(r.storeId)} · ${itemName.get(r.itemId)} -> until ${new Date(r.validUntil).toDateString()}`)
}
log(`${updated} flyer records given a validUntil${DRY_RUN ? ' (dry run, not saved)' : ''}`)
if (!DRY_RUN && updated) await save(db)
