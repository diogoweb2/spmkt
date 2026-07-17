// Grocery category pass: for every NON-meat item in the family db, Claude
// (headless, Haiku — a name-only classification needs no web search) fills in
//   groceryType: produce | dairy | bakery | frozen | pantry | snacks |
//                beverages | household | other
// — the aisle sections of a typical Toronto supermarket, used by Home's
// 🛒 Groceries view to filter deals by category.
//
// Runs automatically at the end of the weekly flyer import (run.mjs) so newly
// imported items get a category. Can also be run standalone:
//   node scripts/flyers/classify-grocery.mjs           # unlabeled items only
//   node scripts/flyers/classify-grocery.mjs --all     # relabel every non-meat item
//   node scripts/flyers/classify-grocery.mjs --dry-run # (npm run classify:grocery / classify:grocery:dry)

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadEnv, findClaude, openFamilyDoc, lastJsonArray, log } from './shared.mjs'

// Keep in sync with GROCERY_TYPES in src/lib/meat.js.
const GROCERY_TYPES = ['produce', 'dairy', 'bakery', 'frozen', 'pantry', 'snacks', 'beverages', 'household', 'other']

const PROMPT = (names) => `You are labeling grocery products for a family price-tracking app in Toronto, Canada, by supermarket section.

For EACH product name below, pick exactly ONE "groceryType":
- "produce": fresh fruits and vegetables, fresh herbs
- "dairy": milk, cheese, yogurt, butter, cream, eggs
- "bakery": bread, buns, bagels, tortillas, cakes, pastries
- "frozen": anything sold frozen (frozen fruit/vegetables/pizza/fries/ice cream)
- "pantry": shelf-stable cooking staples — flour, sugar, rice, pasta, canned goods, sauces, oils, spices, cereal, baking supplies
- "snacks": chips, crackers, cookies, chocolate, candy, granola bars, nuts
- "beverages": juice, pop, water, coffee, tea, plant milks
- "household": cleaning, paper products, laundry, personal care
- "other": anything that fits none of the above

Output ONLY a JSON array (no prose, no markdown fence), one element per product, in the SAME ORDER:
{"name": "<exact input name>", "groceryType": "..."}

Products: ${JSON.stringify(names)}`

// Labels non-meat items missing groceryType (or all with --all).
// Returns the number of items updated.
export async function classifyGrocery(env, { all = false, dryRun = false } = {}) {
  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const grocery = (db.items ?? []).filter((i) => i.category !== 'meat')
  const todo = all ? grocery : grocery.filter((i) => !GROCERY_TYPES.includes(i.groceryType))
  if (!todo.length) {
    log('classify-grocery: nothing to classify')
    return 0
  }

  const claude = findClaude()
  log(`classify-grocery: classifying ${todo.length} items with ${claude}`)
  const out = execFileSync(
    claude,
    ['-p', PROMPT(todo.map((i) => i.name)), '--model', 'claude-haiku-4-5'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 },
  )
  const results = lastJsonArray(out)

  const byName = new Map(todo.map((i) => [i.name.trim().toLowerCase(), i]))
  let updated = 0
  for (const r of results) {
    const item = byName.get(String(r?.name ?? '').trim().toLowerCase())
    if (!item || !GROCERY_TYPES.includes(r.groceryType)) continue
    item.groceryType = r.groceryType
    log(`  ${item.name}: ${item.groceryType}`)
    updated++
  }
  if (dryRun) {
    log(`classify-grocery: dry run — would update ${updated} of ${todo.length} items`)
  } else {
    await save(db)
    log(`classify-grocery: updated ${updated} of ${todo.length} items`)
  }
  return updated
}

// Standalone CLI entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await classifyGrocery(loadEnv(), {
      all: process.argv.includes('--all'),
      dryRun: process.argv.includes('--dry-run'),
    })
  } catch (err) {
    console.error(`classify-grocery FAILED: ${err.message}`)
    process.exit(1)
  }
}
