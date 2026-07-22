// 📷 Photo-mode processor (BUSINESS_RULES §15): reads every 'pending' entry
// in db.photoQueue, downloads its shelf-label photo from Firebase Storage,
// has Claude (headless CLI, Haiku, vision via the Read tool) extract the
// product name, price, quantity/unit, category and meat flags — reusing an
// existing db item name when the product matches — then writes the extraction
// back onto the queue entry (status 'ready') and DELETES the photo from
// Storage. The Review tab shows 'ready' entries as approve/edit cards.
//
//   node scripts/photos/process.mjs             # process pending photos
//   node scripts/photos/process.mjs --dry-run   # extract, don't save/delete
//
// Scheduled by launchd (com.spmkt.photos, daily 9:20) — npm run photos.
// Requires scripts/flyers/service-account.json (admin SDK: Firestore +
// Storage); there is no password fallback because Storage needs admin.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv, findClaude, openFamilyDoc, lastJsonArray, log } from '../flyers/shared.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BUCKET = 'spmkt-cc6fd.firebasestorage.app'

const UNITS = ['kg', 'g', 'lb', 'oz', 'L', 'ml', 'un']
const GROCERY_TYPES = ['produce', 'dairy', 'bakery', 'frozen', 'pantry', 'snacks', 'beverages', 'household', 'other']

const PROMPT = (files, existingNames) => `Use the Read tool to open ${files.length === 1 ? 'this image file' : `these ${files.length} image files, one by one`} — each is a photo of ONE supermarket product / shelf price label, taken by a shopper. You CAN view images via the Read tool:
${files.map((f) => f.path).join('\n')}

For EACH photo, extract the price entry:
- file: the image file name exactly as given (to match your answer back).
- name: the product name. IMPORTANT: if the product matches one of the user's existing items below, return that EXACT existing name (so its price history continues); otherwise a clean generic name (brand + product, no marketing fluff).
- price: the shelf price in dollars (number). If a discount/sale price is shown, use it. MEMBER PRICE: the shopper is a member of every store — if both a member/card/loyalty price (Scene+, Moi, PC Optimum, More Rewards, "member", "with card") and a higher regular price are shown, ALWAYS use the lower MEMBER price.
- qty and unit: what the price buys. unit must be one of ${JSON.stringify(UNITS)}.
  * price per lb/kg label ("/lb", "/kg" — e.g. "12.99/lb  28.64/kg") -> qty 1, unit "lb"/"kg". NEVER use "un" when a per-lb or per-kg price is shown.
  * package with printed weight/volume (750 g, 2 L...) -> qty = that amount, unit g/kg/ml/L.
  * priced by piece with NO weight printed -> qty = piece count, unit "un". NEVER invent a weight.
- category: "meat" for meat/poultry/fish/seafood (fresh, frozen or processed), else "other".
- Meat only — frozen (true/false), bones (true/false), skin (true/false), best guess from the photo/product; processing: "natural" for whole/raw cuts, "ultra" for nuggets/sausages/bacon/deli/breaded/marinated.
- Non-meat only — groceryType: one of ${JSON.stringify(GROCERY_TYPES)} (supermarket section).
- minQty: ONLY for multi-buy prices ("2 for $5", "2/$2.50", "3/$10", "buy 2 or more"): the minimum count required, with price = the PER-ITEM deal price ("2/$2.50" -> price 1.25, minQty 2; a "or $1.50 ea" single price is ignored — the multi-buy is the deal). qty+unit still describe ONE item. Omit for normal prices.
- note: anything important you could read that doesn't fit the fields (member price...), else omit.
- If the photo is unreadable or shows no price, return {"file": "...", "error": "<short reason>"} for it.

The user's existing items: ${JSON.stringify(existingNames)}

Output ONLY a JSON array (no prose, no markdown fence), one element per photo, SAME ORDER as the files.`

export async function processPhotos(env, { dryRun = false } = {}) {
  const keyPath = join(here, '../flyers/service-account.json')
  if (!existsSync(keyPath)) throw new Error('scripts/flyers/service-account.json required (Storage needs the admin SDK)')

  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const pending = (db.photoQueue ?? []).filter((p) => p.status === 'pending')
  if (!pending.length) {
    log('photos: nothing to process')
    return 0
  }

  const { getStorage } = await import('firebase-admin/storage')
  const bucket = getStorage().bucket(BUCKET)

  // Download every pending photo; entries whose photo is gone are failed.
  const tmp = mkdtempSync(join(tmpdir(), 'spmkt-photos-'))
  const files = []
  for (const entry of pending) {
    const path = join(tmp, `${entry.id}.jpg`)
    try {
      await bucket.file(entry.path).download({ destination: path })
      files.push({ entry, path, name: `${entry.id}.jpg` })
    } catch (err) {
      log(`photos: ${entry.id}: download failed (${err.message})`)
      entry.status = 'failed'
      entry.error = 'Photo missing from storage.'
    }
  }

  let ok = 0
  try {
    if (files.length) {
      const claude = findClaude()
      log(`photos: extracting ${files.length} photo(s) with ${claude}`)
      const existingNames = (db.items ?? []).map((i) => i.name)
      const out = execFileSync(
        claude,
        ['-p', PROMPT(files, existingNames), '--allowedTools', 'Read', '--model', 'claude-haiku-4-5'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      )
      const results = lastJsonArray(out)
      const byFile = new Map(results.map((r) => [String(r?.file ?? '').split('/').pop(), r]))

      for (const { entry, name } of files) {
        const r = byFile.get(name)
        const bad =
          !r ? 'No extraction returned.'
          : r.error ? r.error
          : !r.name || !(r.price > 0) ? 'Could not read a product + price.'
          : !(r.qty > 0) || !UNITS.includes(r.unit) ? 'Could not read the quantity/unit.'
          : null
        if (bad) {
          entry.status = 'failed'
          entry.error = String(bad)
          log(`  ${entry.id}: FAILED — ${bad}`)
          continue
        }
        const meat = r.category === 'meat'
        entry.status = 'ready'
        entry.itemName = String(r.name)
        const match = (db.items ?? []).find((i) => i.name.toLowerCase() === entry.itemName.toLowerCase())
        entry.matchedItemId = match?.id ?? null
        entry.price = Math.round(Number(r.price) * 100) / 100
        entry.qty = Number(r.qty)
        entry.unit = r.unit
        entry.category = meat ? 'meat' : 'other'
        if (meat) {
          entry.frozen = !!r.frozen
          entry.bones = !!r.bones
          entry.skin = !!r.skin
          entry.processing = r.processing === 'ultra' ? 'ultra' : 'natural'
        } else {
          entry.groceryType = GROCERY_TYPES.includes(r.groceryType) ? r.groceryType : 'other'
        }
        if (Number.isInteger(r.minQty) && r.minQty >= 2) entry.minQty = r.minQty
        if (r.note) entry.note = String(r.note)
        ok++
        log(`  ${entry.id}: ${entry.itemName} — $${entry.price} / ${entry.qty} ${entry.unit}${match ? ` (matches "${match.name}")` : ''}`)
      }
    }

    if (dryRun) {
      log(`photos: dry run — would mark ${ok} ready (photos kept)`)
      return ok
    }

    await save(db)
    // Photos are only deleted after the extraction is safely saved.
    for (const entry of pending) {
      if (entry.status === 'pending') continue
      await bucket.file(entry.path).delete().catch(() => {})
    }
    log(`photos: ${ok}/${pending.length} ready for review`)
    return ok
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await processPhotos(loadEnv(), { dryRun: process.argv.includes('--dry-run') })
    process.exit(0)
  } catch (err) {
    console.error(`photos FAILED: ${err.message}`)
    process.exit(1)
  }
}
