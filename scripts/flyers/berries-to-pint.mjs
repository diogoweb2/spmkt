// One-off migration: put blueberries on the "pint" unit (BUSINESS_RULES §12).
//
//   node scripts/flyers/berries-to-pint.mjs --dry-run   # list, change nothing
//   node scripts/flyers/berries-to-pint.mjs             # apply
//   node scripts/flyers/berries-to-pint.mjs --match=berr # other berries too
//
// Berries are bought by the container, not by weight — a 340 g clamshell IS
// one pint — but the history has them recorded three different ways (340 g,
// "1 un", and the odd 170 g half pint), so their prices never compared.
// This rewrites the container records onto one unit:
//
//   * a weight record in the pint range (grams / 340, so 340 g -> 1 pint,
//     170 g -> 0.5, 510 g -> 1.5) -> that many pints
//   * "1 un" (a container with no size read off the ad) -> 1 pint
//
// A record priced PER WEIGHT (qty 1 lb/kg — loose berries, not a clamshell)
// is left alone: that price is per pound, not per container, and pretending
// otherwise would invent a container the shopper never bought. Items whose
// records all end up on count units get kind "count" + defaultUnit "pint".

import { pathToFileURL } from 'node:url'
import { loadEnv, openFamilyDoc, log } from './shared.mjs'

const GRAMS = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 }
const PINT_G = 340

// Clamshell sizes only: 0.25 pint (85 g) up to 4 pints (1.36 kg). Anything
// outside that is a per-weight price or a bulk pack, not a container.
const MIN_PINTS = 0.25
const MAX_PINTS = 4

// A per-lb / per-kg price: qty 1 of a shopper-facing weight unit is how the
// extractors record "priced by weight" (§12), never a package size.
const byWeightPrice = (r) => r.qty === 1 && (r.unit === 'lb' || r.unit === 'kg')

function toPints(r) {
  if (r.unit === 'un') return r.qty // a container is a container
  const g = GRAMS[r.unit]
  if (!g || byWeightPrice(r)) return null
  const pints = Math.round(((r.qty * g) / PINT_G) * 100) / 100
  return pints >= MIN_PINTS && pints <= MAX_PINTS ? pints : null
}

export async function berriesToPint(env, { dryRun = false, match = 'blueberr' } = {}) {
  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const re = new RegExp(match, 'i')

  const items = (db.items ?? []).filter((i) => re.test(i.name))
  if (!items.length) {
    log(`pint: no items matching /${match}/i`)
    return 0
  }

  let changed = 0
  for (const item of items) {
    const recs = (db.records ?? []).filter((r) => r.itemId === item.id)
    log(`  ${item.name} — ${recs.length} record(s), kind ${item.kind}`)
    for (const r of recs) {
      if (r.unit === 'pint') continue
      const pints = toPints(r)
      if (pints == null) {
        log(`    keep  $${r.price} / ${r.qty} ${r.unit} (priced by weight — not a container)`)
        continue
      }
      log(`    ${dryRun ? 'would set' : 'set'} $${r.price} / ${r.qty} ${r.unit} -> ${pints} pint`)
      if (!dryRun) {
        r.qty = pints
        r.unit = 'pint'
      }
      changed++
    }

    // The item's kind has to follow its records, or every rewritten record
    // reads as a "by piece" price against a weight item (§12).
    const after = recs.map((r) => (dryRun ? (toPints(r) != null ? 'pint' : r.unit) : r.unit))
    if (after.length && after.every((u) => u === 'pint' || u === 'un')) {
      if (item.kind !== 'count' || item.defaultUnit !== 'pint') {
        log(`    ${dryRun ? 'would set' : 'set'} item kind count, defaultUnit pint`)
        if (!dryRun) {
          item.kind = 'count'
          item.defaultUnit = 'pint'
        }
      }
    } else if (after.some((u) => u === 'pint')) {
      log(`    item keeps kind ${item.kind} — it still has per-weight records`)
    }
  }

  if (dryRun) {
    log(`pint: dry run — would rewrite ${changed} record(s)`)
    return changed
  }
  if (changed) await save(db)
  log(`pint: rewrote ${changed} record(s) across ${items.length} item(s)`)
  return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const matchArg = process.argv.find((a) => a.startsWith('--match='))
  try {
    await berriesToPint(loadEnv(), {
      dryRun: process.argv.includes('--dry-run'),
      match: matchArg ? matchArg.slice('--match='.length) : undefined,
    })
    process.exit(0)
  } catch (err) {
    console.error(`pint FAILED: ${err.message}`)
    process.exit(1)
  }
}
