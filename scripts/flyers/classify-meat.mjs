// Meat classification pass: for every meat item in the family db, Claude
// (headless, with web search) fills in
//   meatType:   beef | pork | chicken | fish | other
//   processing: natural (whole/raw cuts) | ultra (nuggets, sausages, deli...)
//   market:     { excellent, good, avg, updatedAt } — CAD $/lb thresholds for
//               Toronto supermarkets since Jan 2026 (prices jumped after the
//               Iran war, so older data is misleading), used by the app to
//               rate a current deal as excellent/good/average/bad.
//
// Runs automatically at the end of the weekly flyer import (run.mjs), which
// refreshes stale market numbers and classifies newly imported and manually
// added items. Can also be run standalone:
//   node scripts/flyers/classify-meat.mjs          # missing/stale items only
//   node scripts/flyers/classify-meat.mjs --all    # reclassify every meat item
//   node scripts/flyers/classify-meat.mjs --dry-run

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadEnv, findClaude, openFamilyDoc, lastJsonArray, log } from './shared.mjs'

const STALE_MS = 6 * 24 * 3600 * 1000 // refresh market numbers weekly (job runs every 7 days)
const MEAT_TYPES = ['beef', 'pork', 'chicken', 'fish', 'other']

const PROMPT = (names) => `You are labeling meat products for a family grocery price-tracking app in Toronto, Canada. Today is ${new Date().toDateString()}.

For EACH product name below, determine:
- "meatType": one of "beef" | "pork" | "chicken" | "fish" | "other". Fish includes all seafood (shrimp, salmon, tilapia...). Turkey, lamb, duck, goat, veal and multi-meat products are "other".
- "processing": "natural" for whole or raw cuts (steaks, roasts, chops, ground meat, raw chicken pieces, whole fish, fillets, raw shrimp) or "ultra" for ultra-processed / prepared products (nuggets, anything breaded or battered, sausages, hot dogs, bacon, deli/luncheon meats, burgers/patties, meatballs, marinated or seasoned ready-to-cook meals, canned meat, fish sticks).
- "market": typical Toronto supermarket prices for this exact product SINCE JANUARY 2026 ONLY, in CAD per pound: {"excellent": N, "good": N, "avg": N} where excellent = an exceptional sale price you'd stock up at, good = a solid sale price, avg = the typical everyday shelf price. Must satisfy excellent <= good <= avg. IMPORTANT: meat prices rose sharply after the Iran war — anything you remember from 2025 or earlier is too low and must NOT be used. Ground your numbers in CURRENT reality: use the WebSearch tool to check real 2026 Toronto flyer and shelf prices (flyers, RedFlagDeals, SaleWhale, Reddit, store sites); "avg" must match what the product actually costs on the shelf this year, and "excellent" must be a sale price that has actually appeared in a 2026 flyer, not a historical best. For products sold by package rather than weight, still estimate per-pound prices.

Output ONLY a JSON array (no prose, no markdown fence), one element per product, in the SAME ORDER:
{"name": "<exact input name>", "meatType": "...", "processing": "...", "market": {"excellent": N, "good": N, "avg": N}}

Products: ${JSON.stringify(names)}`

// Classifies meat items missing meatType/processing/market and refreshes
// market thresholds older than STALE_MS. Returns the number of items updated.
export async function classifyMeat(env, { all = false, dryRun = false } = {}) {
  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const meat = (db.items ?? []).filter((i) => i.category === 'meat')
  const todo = all
    ? meat
    : meat.filter(
        (i) => !i.meatType || !i.processing || !i.market || Date.now() - (i.market.updatedAt ?? 0) > STALE_MS,
      )
  if (!todo.length) {
    log('classify-meat: nothing to classify')
    return 0
  }

  const claude = findClaude()
  log(`classify-meat: classifying ${todo.length} items with ${claude}`)
  const out = execFileSync(
    claude,
    ['-p', PROMPT(todo.map((i) => i.name)), '--allowedTools', 'WebSearch', '--model', 'claude-sonnet-5'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 },
  )
  const results = lastJsonArray(out)

  const byName = new Map(todo.map((i) => [i.name.trim().toLowerCase(), i]))
  let updated = 0
  for (const r of results) {
    const item = byName.get(String(r?.name ?? '').trim().toLowerCase())
    if (!item) continue
    if (MEAT_TYPES.includes(r.meatType)) item.meatType = r.meatType
    if (r.processing === 'natural' || r.processing === 'ultra') item.processing = r.processing
    const m = r.market
    if (m && [m.excellent, m.good, m.avg].every((n) => typeof n === 'number' && n > 0)) {
      // Enforce excellent <= good <= avg even if the model slipped.
      const [excellent, good, avg] = [m.excellent, m.good, m.avg].sort((a, b) => a - b)
      item.market = { excellent, good, avg, updatedAt: Date.now() }
    }
    log(`  ${item.name}: ${item.meatType}/${item.processing}, $/lb ex ${item.market?.excellent} good ${item.market?.good} avg ${item.market?.avg}`)
    updated++
  }
  if (dryRun) {
    log(`classify-meat: dry run — would update ${updated} of ${todo.length} items`)
  } else {
    await save(db)
    log(`classify-meat: updated ${updated} of ${todo.length} items`)
  }
  return updated
}

// Standalone CLI entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await classifyMeat(loadEnv(), {
      all: process.argv.includes('--all'),
      dryRun: process.argv.includes('--dry-run'),
    })
  } catch (err) {
    console.error(`classify-meat FAILED: ${err.message}`)
    process.exit(1)
  }
}
