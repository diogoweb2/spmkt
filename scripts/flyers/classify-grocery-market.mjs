// Grocery market pass: for NON-meat items in the family db, Claude (headless,
// Sonnet with web search — price research needs current web grounding, unlike
// the name-only Haiku groceryType pass) fills in
//   market: { excellent, good, avg, per, updatedAt } — Toronto supermarket
//           price thresholds in CAD, per the item's kind: $/lb (weight),
//           $/L (volume) or $/unit (count) — used by the app to rate a
//           current grocery deal as excellent/good/average/bad, exactly like
//           meat deals.
//
// Unlike meat, this pass does NOT refresh stale thresholds automatically
// (groceries are many and their prices move slower); it targets items with no
// market data. Runs at the end of the weekly flyer import (run.mjs) so new
// imports get thresholds. Standalone:
//   node scripts/flyers/classify-grocery-market.mjs           # items with no market data only
//   node scripts/flyers/classify-grocery-market.mjs --all     # re-research every non-meat item
//   node scripts/flyers/classify-grocery-market.mjs --dry-run # (npm run classify:market / classify:market:dry)

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadEnv, findClaude, openFamilyDoc, lastJsonArray, log } from './shared.mjs'

// One web-search call can only research so many products well; chunk --all runs.
const CHUNK = 40

// Threshold basis per item kind, matching the app's display units.
const PER = { weight: 'lb', volume: 'L', count: 'un' }
const PER_LABEL = { lb: 'per pound', L: 'per litre', un: 'per unit/package' }

const PROMPT = (products) => `You are researching grocery prices for a family price-tracking app in Toronto, Canada. Today is ${new Date().toDateString()}.

For EACH product below, give typical Toronto supermarket prices SINCE JANUARY 2026 ONLY, in CAD, in the basis stated for that product ("per pound", "per litre" or "per unit/package"):
{"excellent": N, "good": N, "avg": N} where excellent = an exceptional sale price you'd stock up at, good = a solid sale price, avg = the typical everyday shelf price. Must satisfy excellent <= good <= avg.
IMPORTANT: grocery prices rose sharply in 2025–2026 — anything you remember from 2025 or earlier is likely too low and must NOT be used. Ground your numbers in CURRENT reality: use the WebSearch tool to check real 2026 Toronto flyer and shelf prices (flyers, RedFlagDeals, SaleWhale, Reddit, store sites); "avg" must match what the product actually costs on the shelf this year, and "excellent" must be a sale price that has actually appeared in a 2026 flyer, not a historical best. For "per unit/package" products, price the typical retail package size the name suggests.

Output ONLY a JSON array (no prose, no markdown fence), one element per product, in the SAME ORDER:
{"name": "<exact input name>", "market": {"excellent": N, "good": N, "avg": N}}

Products (name — price basis): ${JSON.stringify(products.map((p) => `${p.name} — ${PER_LABEL[p.per]}`))}`

// Researches market thresholds for non-meat items missing them (or all with
// --all). Returns the number of items updated.
export async function classifyGroceryMarket(env, { all = false, dryRun = false } = {}) {
  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const grocery = (db.items ?? []).filter((i) => i.category !== 'meat')
  const todo = all ? grocery : grocery.filter((i) => !i.market)
  if (!todo.length) {
    log('classify-grocery-market: nothing to research')
    return 0
  }

  const claude = findClaude()
  log(`classify-grocery-market: researching ${todo.length} items with ${claude}`)
  let updated = 0
  for (let at = 0; at < todo.length; at += CHUNK) {
    const chunk = todo.slice(at, at + CHUNK)
    const out = execFileSync(
      claude,
      [
        '-p',
        PROMPT(chunk.map((i) => ({ name: i.name, per: PER[i.kind] ?? 'un' }))),
        '--allowedTools', 'WebSearch',
        '--model', 'claude-sonnet-5',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 },
    )
    const results = lastJsonArray(out)

    const byName = new Map(chunk.map((i) => [i.name.trim().toLowerCase(), i]))
    for (const r of results) {
      const item = byName.get(String(r?.name ?? '').trim().toLowerCase())
      const m = r?.market
      if (!item || !m || ![m.excellent, m.good, m.avg].every((n) => typeof n === 'number' && n > 0)) continue
      // Enforce excellent <= good <= avg even if the model slipped.
      const [excellent, good, avg] = [m.excellent, m.good, m.avg].sort((a, b) => a - b)
      item.market = { excellent, good, avg, per: PER[item.kind] ?? 'un', updatedAt: Date.now() }
      log(`  ${item.name}: $/${item.market.per} ex ${excellent} good ${good} avg ${avg}`)
      updated++
    }
  }
  if (dryRun) {
    log(`classify-grocery-market: dry run — would update ${updated} of ${todo.length} items`)
  } else {
    await save(db)
    log(`classify-grocery-market: updated ${updated} of ${todo.length} items`)
  }
  return updated
}

// Standalone CLI entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await classifyGroceryMarket(loadEnv(), {
      all: process.argv.includes('--all'),
      dryRun: process.argv.includes('--dry-run'),
    })
  } catch (err) {
    console.error(`classify-grocery-market FAILED: ${err.message}`)
    process.exit(1)
  }
}
