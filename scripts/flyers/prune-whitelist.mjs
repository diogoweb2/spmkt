// Whitelist cleanup pass: reviews every NON-MEAT item in the family db
// against the import whitelist (Settings → Import) using Claude Opus, and
// deletes the items (and all their price records) that match no rule —
// old imports from before the whitelist existed, or extraction slips by the
// cheaper import model. Meat is exempt, exactly like the import itself.
//
// Guard: an item with at least one MANUAL price record (source != 'flyer')
// is never deleted — the user typed that price in, so it's wanted regardless
// of the whitelist. Deleted items are NOT added to the ignored list: the
// whitelist already keeps them from coming back.
//
//   npm run prune           # review + delete
//   npm run prune:dry       # review only, print what would be deleted
//
// Run manually whenever Home → Groceries shows products you don't care about.

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadEnv, findClaude, openFamilyDoc, lastJsonArray, log } from './shared.mjs'

const PROMPT = (rules, names) => `You are cleaning up a family grocery price-tracking app. The user keeps a WHITELIST of the only product kinds they want in the app. Below are the whitelist rules and a list of product names currently in the database.

WHITELIST RULES (plain language, may carry exceptions — honor them exactly):
${JSON.stringify(rules)}

Rules are interpreted, not string-matched, and they are STRICT:
· A product KEEPS only if some rule covers its product category AND the product satisfies every qualifier of that rule.
· Qualifiers are hard limits, not suggestions: "Yogurt but only Oikos brand" -> Oikos yogurt keeps, EVERY other yogurt (Modhani, Activia, store brand...) is removed. "Bread but only brioche" -> all non-brioche bread removed. "Coconut water but only cans" -> bottled/carton coconut water removed.
· Enumerations are exhaustive: "Fruits: apples, grapes, oranges, tangerines, berries, bananas" -> those fruits in any variety keep (Gala apples, red grapes); every OTHER fruit or vegetable is removed (melon, pineapple, tomatoes, potatoes...). Do not use botanical pedantry — a tomato does not keep because it is technically a fruit.
· A product category no rule mentions at all (pasta, rice, ice cream, frozen desserts, cereal, sauces...) is ALWAYS removed. Absence of a rule IS the user saying no. Do not stretch a rule to a neighboring category: ice cream is not "cookies", a frozen dessert is not "frozen waffles", crackers are not "chips".
Only when a product's identity is genuinely unclear from its name alone (you cannot tell what the product IS) should you keep it.

For EACH product below, decide: keep (a specific rule covers it, all qualifiers satisfied) or remove.

Output ONLY a JSON array (no prose, no markdown fence), one element per product, SAME ORDER, using the EXACT input name:
{"name": "<exact input name>", "keep": true|false, "why": "<keep: which rule and why its qualifiers are satisfied | remove: short reason>"}

Products: ${JSON.stringify(names)}`

export async function pruneWhitelist(env, { dryRun = false } = {}) {
  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const rules = (db.whitelist ?? []).map((r) => r.text)
  if (!db.whitelistOn || !rules.length) {
    log('prune-whitelist: whitelist is off or empty — nothing to prune against')
    return 0
  }

  // Meat is exempt (like the import); manual prices mark an item as wanted.
  const manualItemIds = new Set(
    (db.records ?? []).filter((r) => r.source !== 'flyer').map((r) => r.itemId),
  )
  const candidates = (db.items ?? []).filter(
    (i) => i.category !== 'meat' && !manualItemIds.has(i.id),
  )
  if (!candidates.length) {
    log('prune-whitelist: no flyer-only non-meat items to review')
    return 0
  }

  const claude = findClaude()
  log(`prune-whitelist: reviewing ${candidates.length} items against ${rules.length} rules with ${claude} (opus)`)
  const out = execFileSync(
    claude,
    ['-p', PROMPT(rules, candidates.map((i) => i.name)), '--model', 'claude-opus-4-8'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 },
  )
  const results = lastJsonArray(out)

  const byName = new Map(candidates.map((i) => [i.name.trim().toLowerCase(), i]))
  const removeIds = new Set()
  for (const r of results) {
    const item = byName.get(String(r?.name ?? '').trim().toLowerCase())
    if (!item) continue
    if (r.keep === false) {
      removeIds.add(item.id)
      log(`  remove: ${item.name} — ${r.why ?? 'no rule matched'}`)
    }
  }
  const kept = candidates.length - removeIds.size
  if (!removeIds.size) {
    log(`prune-whitelist: all ${kept} items match the whitelist — nothing to delete`)
    return 0
  }
  if (dryRun) {
    log(`prune-whitelist: dry run — would delete ${removeIds.size} items (${kept} kept)`)
    return removeIds.size
  }
  const recsBefore = db.records.length
  db.items = db.items.filter((i) => !removeIds.has(i.id))
  db.records = db.records.filter((r) => !removeIds.has(r.itemId))
  await save(db)
  log(`prune-whitelist: deleted ${removeIds.size} items and ${recsBefore - db.records.length} records (${kept} kept)`)
  return removeIds.size
}

// Standalone CLI entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await pruneWhitelist(loadEnv(), { dryRun: process.argv.includes('--dry-run') })
  } catch (err) {
    console.error(`prune-whitelist FAILED: ${err.message}`)
    process.exit(1)
  }
}
