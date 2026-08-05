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
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv, findClaude, openFamilyDoc, lastJsonArray, log, sendPush } from '../flyers/shared.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BUCKET = 'spmkt-cc6fd.firebasestorage.app'

// Sonnet at low effort, not Haiku. Haiku was the right call when this job
// shared a budget with the whole-flyer import (§12) reading dozens of pages a
// week — that import is retired, and this now reads a handful of hand-cropped
// single deals a day, so the volume argument for the cheaper model is gone.
// The flyer import had already found Haiku weak at exactly what matters here:
// package sizes in small print, member vs regular price, and reusing an
// existing item name correctly. A misread costs a manual fix in Review, which
// is the work this whole pipeline exists to avoid.
const MODEL = 'claude-sonnet-5'
const EFFORT = 'low'

// Extractions become price records immediately instead of queueing as Review
// cards. The Review step existed because the cheaper model was unreliable;
// with Sonnet reading one hand-cropped deal at a time it costs more attention
// than it saves. `--review` restores the old approve-every-card behaviour.
const AUTO_APPROVE = !process.argv.includes('--review')

const UNITS = ['kg', 'g', 'lb', 'oz', 'L', 'ml', 'un', 'pint']
const KINDS = { weight: ['kg', 'g', 'lb', 'oz'], volume: ['L', 'ml'], count: ['un', 'pint'] }
const kindOf = (unit) => Object.keys(KINDS).find((k) => KINDS[k].includes(unit))
const GROCERY_TYPES = ['produce', 'dairy', 'bakery', 'frozen', 'pantry', 'snacks', 'beverages', 'household', 'other']

const PROMPT = (files, existingNames) => `Use the Read tool to open ${files.length === 1 ? 'this image file' : `these ${files.length} image files, one by one`} — each shows ONE supermarket deal: either a photo of a shelf price label taken by a shopper, or a crop the shopper drew around a single ad block in a store flyer (§17). Both carry the same fields; a flyer crop is just printed rather than photographed, and its price is already the sale price. You CAN view images via the Read tool:
${files.map((f) => f.path).join('\n')}

For EACH photo, extract the price entry:
- file: the image file name exactly as given (to match your answer back).
- name: the product name. IMPORTANT: if the product matches one of the user's existing items below, return that EXACT existing name (so its price history continues); otherwise a clean generic name (brand + product, no marketing fluff).
- price: the shelf price in dollars (number). If a discount/sale price is shown, use it. MEMBER PRICE: the shopper is a member of every store — if both a member/card/loyalty price (Scene+, Moi, PC Optimum, More Rewards, "member", "with card") and a higher regular price are shown, ALWAYS use the lower MEMBER price.
- qty and unit: what the price buys. unit must be one of ${JSON.stringify(UNITS)}.
  * price per lb/kg label ("/lb", "/kg" — e.g. "12.99/lb  28.64/kg") -> qty 1, unit "lb"/"kg". NEVER use "un" when a per-lb or per-kg price is shown.
  * package with printed weight/volume (750 g, 2 L...) -> qty = that amount, unit g/kg/ml/L.
  * priced by piece with NO weight printed -> qty = piece count, unit "un". NEVER invent a weight.
  * berries in a clamshell/basket (blueberries, raspberries, blackberries, strawberries) -> unit "pint", NEVER "un" and never grams: the shopper buys these by the container. One pint = 340 g, so qty = printed grams / 340 rounded to 2 decimals (340 g -> qty 1, 170 g -> 0.5, 510 g -> 1.5, 2 lb / 907 g -> 2.67); no size printed, or labelled "pint"/"1 pt"/"dry pint" -> qty 1.
- category: "meat" for meat/poultry/fish/seafood (fresh, frozen or processed), else "other".
- Meat only — frozen (true/false), bones (true/false), skin (true/false), best guess from the photo/product; processing: "natural" for whole/raw cuts, "ultra" for nuggets/sausages/bacon/deli/breaded/marinated.
- Non-meat only — groceryType: one of ${JSON.stringify(GROCERY_TYPES)} (supermarket section).
- minQty: ONLY for multi-buy prices ("2 for $5", "2/$2.50", "3/$10", "buy 2 or more"): the minimum count required, with price = the PER-ITEM deal price ("2/$2.50" -> price 1.25, minQty 2; a "or $1.50 ea" single price is ignored — the multi-buy is the deal). qty+unit still describe ONE item. Omit for normal prices.
- Flyer crops specifically: a "SAVE UP TO 38%" / "1/2 PRICE" splash is NOT the price — the big number with ¢ superscript is (e.g. "7 99 /LB" -> price 7.99, qty 1, unit "lb"). When a per-lb price and its per-kg equivalent are both printed ("7.99/LB  17.61/KG"), use the lb one. The small print under the product name carries the package size and the variant words (skinless, bone-in, fresh, frozen, club size) — read it before answering.
- note: anything important you could read that doesn't fit the fields (member price...), else omit.
- If the photo is unreadable or shows no price, return {"file": "...", "error": "<short reason>"} for it.

The user's existing items: ${JSON.stringify(existingNames)}

Output ONLY a JSON array (no prose, no markdown fence), one element per photo, SAME ORDER as the files.`

// A permanent, app-readable URL for a kept crop. The client normally gets this
// from getDownloadURL(); server-side the equivalent is to stamp the object with
// a download token and build the same URL by hand. (A V4 signed URL would
// expire in a week and take the picture off the deal card with it.)
async function publicImageUrl(bucket, path) {
  const token = randomUUID()
  await bucket.file(path).setMetadata({ metadata: { firebaseStorageDownloadTokens: token } })
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`
}

// Auto-approve: turn an extracted entry straight into a price record, the same
// way the app's ✓ Approve does (src/lib/photos.js applyEntry) — item matched by
// id or exact name else created, flyer provenance and the kept crop carried
// onto the record, image-less flyer duplicates for that item+store this week
// dropped in favour of the illustrated one (§17). Mutates db; the caller saves.
function approveEntry(db, entry, imgUrl) {
  const meat = entry.category === 'meat'
  db.items ??= []
  db.records ??= []
  let item =
    db.items.find((i) => i.id === entry.matchedItemId) ??
    db.items.find((i) => i.name.trim().toLowerCase() === entry.itemName.trim().toLowerCase())
  if (!item) {
    // meatType/market stay null: the classify pass (§13) fills them in, the
    // same as for an item created by the import.
    item = {
      id: `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: entry.itemName.trim(),
      category: meat ? 'meat' : 'other',
      kind: kindOf(entry.unit),
      defaultUnit: entry.unit,
      annualQty: null,
      meatType: null,
      processing: meat ? (entry.processing ?? 'natural') : null,
      market: null,
      ...(meat ? {} : { groceryType: entry.groceryType ?? 'other' }),
    }
    db.items.push(item)
  }
  const flyer = entry.source === 'flyer'
  db.records.push({
    id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    itemId: item.id,
    storeId: entry.storeId,
    price: entry.price,
    qty: entry.qty,
    unit: entry.unit,
    frozen: meat ? !!entry.frozen : null,
    bones: meat ? !!entry.bones : null,
    skin: meat ? !!entry.skin : null,
    ...(Number.isInteger(entry.minQty) && entry.minQty >= 2 ? { minQty: entry.minQty } : {}),
    ...(flyer
      ? {
          ...(entry.itemName.trim().toLowerCase() !== item.name.trim().toLowerCase() ? { origName: entry.itemName.trim() } : {}),
          source: 'flyer',
          validUntil: entry.validUntil ?? null,
          flyerUrl: entry.flyerUrl ?? null,
          flyerPage: entry.flyerPage ?? null,
          ...(entry.upcoming ? { upcoming: true } : {}),
        }
      : {
          ...(entry.itemName.trim().toLowerCase() !== item.name.trim().toLowerCase() ? { origName: entry.itemName.trim() } : {}),
          source: 'photo',
        }),
    ...(flyer && imgUrl ? { imgPath: entry.path, imgUrl } : {}),
    ts: entry.ts,
  })
  if (flyer && imgUrl) {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    db.records = db.records.filter(
      (r) => !(r.source === 'flyer' && !r.imgPath && r.itemId === item.id && r.storeId === entry.storeId && r.ts > weekAgo),
    )
  }
  db.photoQueue = (db.photoQueue ?? []).filter((p) => p.id !== entry.id)
  return item.name
}

// Storage cleanup for the visual deal list (§17): an approved flyer crop keeps
// its ad image on the record so Home can show it, which means nothing deletes
// it at approval time. Once the deal is over the picture is dead weight, so
// every run drops the image of any flyer record whose validity window has
// passed and clears `imgPath`/`imgUrl` from the record. Records with no
// validUntil are left alone — there's no date saying the deal is done.
// Returns the number of images deleted; mutates db (the caller saves).
async function purgeExpiredImages(db, bucket, dryRun) {
  const now = Date.now()
  const stale = (db.records ?? []).filter((r) => r.imgPath && r.validUntil && r.validUntil < now)
  if (!stale.length) return 0
  if (dryRun) {
    log(`photos: dry run — would delete ${stale.length} expired deal image(s)`)
    return 0
  }
  let n = 0
  for (const r of stale) {
    await bucket.file(r.imgPath).delete().catch(() => {})
    delete r.imgPath
    delete r.imgUrl
    n++
  }
  log(`photos: deleted ${n} expired deal image(s)`)
  return n
}

export async function processPhotos(env, { dryRun = false } = {}) {
  const keyPath = join(here, '../flyers/service-account.json')
  if (!existsSync(keyPath)) throw new Error('scripts/flyers/service-account.json required (Storage needs the admin SDK)')

  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  const { getStorage } = await import('firebase-admin/storage')
  const bucket = getStorage().bucket(BUCKET)

  const pending = (db.photoQueue ?? []).filter((p) => p.status === 'pending')
  if (!pending.length) {
    // Still worth a run: expired deal images have to be cleaned up, and the
    // Review inbox still needs its reminder — the usual morning case is
    // yesterday's crops already extracted and waiting to be approved.
    log('photos: nothing to process')
    const purged = await purgeExpiredImages(db, bucket, dryRun)
    if (purged) await save(db)
    if (!dryRun) await remindReview(env, db)
    return 0
  }

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
  let approved = 0
  try {
    if (files.length) {
      const claude = findClaude()
      log(`photos: extracting ${files.length} photo(s) with ${claude}`)
      const existingNames = (db.items ?? []).map((i) => i.name)
      const out = execFileSync(
        claude,
        ['-p', PROMPT(files, existingNames), '--allowedTools', 'Read', '--model', MODEL, ...(EFFORT ? ['--effort', EFFORT] : [])],
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

        // Auto-approve (default): a hand-cropped single deal read by Sonnet is
        // reliable enough that reviewing 70+ cards one by one costs more than
        // it catches. Two cases still stop for the user, because no model can
        // resolve them from the picture: a `un` extraction (no size printed
        // anywhere, so the price isn't comparable — §12) and a NEW product
        // priced by weight-less count. Failed extractions stay queued as well.
        if (!AUTO_APPROVE) continue
        if (entry.unit === 'un') {
          log('    → left in Review (no size found — needs a weight)')
          continue
        }
        let imgUrl = null
        if (entry.source === 'flyer' && entry.path && !dryRun) {
          imgUrl = await publicImageUrl(bucket, entry.path).catch((err) => {
            log(`    image URL failed (${err.message})`)
            return null
          })
        }
        if (!dryRun) {
          const into = approveEntry(db, entry, imgUrl)
          approved++
          log(`    → saved as “${into}”`)
        }
      }
    }

    if (dryRun) {
      log(`photos: dry run — would mark ${ok} ready (photos kept)`)
      await purgeExpiredImages(db, bucket, true)
      return ok
    }

    await purgeExpiredImages(db, bucket, false)
    await save(db)
    // Photos are only deleted after the extraction is safely saved.
    // Flyer crops (§17) are the exception: they're small, and the Review card
    // showing the actual ad block is how the user checks the price and size the
    // extraction claims. The app deletes them on approve/discard
    // (deleteEntryImage in src/screens/Review.jsx), so they don't accumulate.
    for (const entry of pending) {
      if (entry.status === 'pending' || entry.source === 'flyer') continue
      await bucket.file(entry.path).delete().catch(() => {})
    }
    log(`photos: ${ok}/${pending.length} extracted, ${approved} saved as prices`)
    await remindReview(env, db, approved)
    return ok
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// Web-push reminder: anything sitting in the Review inbox waiting on the user.
// A flyer crop or a shelf photo is worthless until it's approved into a price,
// and the queue is out of sight on the Review tab — so the morning run says
// what's waiting. Silent when the inbox is empty (no "0 items" push), and a
// no-op without registered devices or the admin SDK (sendPush handles both).
async function remindReview(env, db, approved = 0) {
  const queue = db.photoQueue ?? []
  const ready = queue.filter((p) => p.status === 'ready').length
  const failed = queue.filter((p) => p.status === 'failed').length
  if (!ready && !failed && !approved) {
    log('review: nothing saved, inbox empty — no push sent')
    return
  }
  const parts = []
  if (approved) parts.push(`${approved} new price${approved === 1 ? '' : 's'} added`)
  if (ready) parts.push(`${ready} need${ready === 1 ? 's' : ''} a size`)
  if (failed) parts.push(`${failed} couldn't be read`)
  await sendPush(env, {
    title: approved ? '🏷️ New deals in Smart Price' : '📷 Review waiting',
    body: parts.join(' · '),
  })
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
