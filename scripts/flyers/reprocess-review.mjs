// Reprocess the Review inbox with a stronger model (Claude Opus).
//
// The weekly import (run.mjs, Haiku) parks deals it couldn't fully read in the
// Review tab (photoQueue, status 'ready'): no weight found, a unit that didn't
// fit, a generic/grouped name. This job re-reads ONLY the specific flyer PAGE
// each parked deal came from (never the whole flyer — that would burn tokens)
// with Opus, and:
//   - fixes the unit (per-lb / per-kg prices, member/loyalty pricing),
//   - fixes generic names (e.g. "Cookies" -> the real product) and decides
//     whether to fold the deal into an existing merge group,
//   - if it can now read a real weight/volume, SAVES it as a price record and
//     clears it from Review; otherwise leaves it in Review with the fixes.
//
// Usage:
//   npm run reprocess          # apply
//   npm run reprocess:dry      # print what it would change, save nothing
//
// One Opus call per unique (store, page): all the entries on that page are
// re-read together. Pages are fetched fresh from the flyer's own URL (stored on
// each entry), so it works even for entries imported before page images were
// uploaded to Storage.

import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log, loadEnv, findClaude, openFamilyDoc, lastJsonArray, flyerImageUrls } from './shared.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
const MODEL = 'claude-opus-4-8'
const BUCKET = 'spmkt-cc6fd.firebasestorage.app'
const UNITS = { weight: ['kg', 'g', 'lb', 'oz'], volume: ['L', 'ml'], count: ['un'] }
const ALL_UNITS = Object.values(UNITS).flat()

const kindOf = (unit) => Object.keys(UNITS).find((k) => UNITS[k].includes(unit))
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

// ---------- fetch one flyer page image ----------

const htmlCache = new Map()
async function fetchPageImage(flyerUrl, flyerPage, dir) {
  if (!htmlCache.has(flyerUrl)) {
    const res = await fetch(flyerUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error(`fetch ${flyerUrl}: HTTP ${res.status}`)
    htmlCache.set(flyerUrl, flyerImageUrls(await res.text()))
  }
  const urls = htmlCache.get(flyerUrl)
  const imgUrl = urls[flyerPage - 1]
  if (!imgUrl) throw new Error(`page ${flyerPage} not in flyer (${urls.length} pages)`)
  const imgRes = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: flyerUrl } })
  if (!imgRes.ok) throw new Error(`page image HTTP ${imgRes.status}`)
  const file = join(dir, `page-${flyerPage}-${uid('i')}.jpg`)
  writeFileSync(file, Buffer.from(await imgRes.arrayBuffer()))
  return file
}

// ---------- Opus prompt ----------

const PROMPT = (imgPath, entries, existingNames, groups) => `Use the Read tool to open this ONE flyer page image (you CAN view images via the Read tool):
${imgPath}

This single page contains the products listed below, which an earlier weaker pass could not read correctly. For EACH listed product, FIND it on the page and re-extract its deal accurately. Output ONLY a JSON array, one element per listed product, echoing its "ref":
{"ref": number, "found": boolean, "name": string, "origName": string, "category": "meat"|"other", "price": number, "qty": number, "unit": "kg"|"g"|"lb"|"oz"|"L"|"ml"|"un", "frozen": boolean|null, "bones": boolean|null, "skin": boolean|null, "minQty": number|null, "group": string|null}

Products to re-read (match by the wording; they ARE on this page):
${entries.map((e, i) => `  ref ${i}: "${e.origName || e.itemName}"${e.origName && e.itemName && e.origName !== e.itemName ? ` (currently grouped as "${e.itemName}")` : ''} — earlier read: $${e.price}/${e.unit}`).join('\n')}

Rules — apply ALL of them:
- found: true if you can locate the product and read a usable price. If you truly cannot find it on the page, set found=false and copy the earlier values.
- MEMBER / LOYALTY PRICE — the shopper is a member of EVERY store. When the flyer shows a lower member/card price (labelled "MEMBER", "MEMBER PRICING", "with card", or a loyalty brand — Scene+, Moi, PC Optimum, More Rewards, AIR MILES) AND a higher regular price ("without Scene+ Card", "non-member", "non moi price"), ALWAYS use the lower MEMBER price. E.g. "MEMBER ONLY 11.99/lb · without Scene+ Card 12.99/lb" -> price 11.99.
- PRICED BY WEIGHT — if a "/lb", " lb", "/kg" or " kg" appears next to the price (e.g. "12.99/lb  28.64/kg"), the product is sold BY WEIGHT: unit "lb" (qty 1) when "/lb" is shown, else "kg" (qty 1). NEVER output "un" for a product with a per-lb or per-kg price. Most fresh meat, deli and loose produce is priced this way.
- Otherwise prefer a printed weight/volume (read it off the title OR the product image) with qty = that amount. If no size is printed in the title OR on the product image, LOOK UP the standard Canadian retail size with the WebSearch tool (e.g. "Oikos 4 pack yogurt weight" -> 4 x 100 g = qty 400 unit "g"), using the pack count visible in the ad. Allowed for packaged/bottled groceries and PROCESSED meat/fish only — NEVER for fresh meat, poultry, fish or loose produce. Only when NO size, NO per-weight price and NO confident lookup exists -> unit "un", qty = piece count (1 if unknown). Berries sold as a "pint" -> qty 340 unit "g".
- minQty — multi-buy ("2 for $5", "2/$2.50", "3/$10"): price = per-item price, minQty = the minimum count. Normal prices -> minQty null.
- name: the REAL, specific product name (brand + product), e.g. "Angus Beef Outside Round Steak", "Christie Oreo Cookies" — NOT a vague generic like just "Cookies" or "Beef Steak". origName: the exact flyer wording.
- Meat/fish/poultry: category "meat" with frozen/bones/skin inferred (skinless/boneless/fresh etc.); non-meat: those three are null.
- group: decide whether this product should be FOLDED INTO one of the user's existing merge groups so similar products compare side by side. If it clearly belongs to a group below (e.g. any cookie -> a "Cookies" group, any steak -> a "Beef Steak" group), set group to that group's EXACT name; otherwise null (it stays its own product under "name"). Only group when it genuinely fits.
${groups.length ? `Existing merge groups (name -> example members): ${JSON.stringify(groups)}` : 'No merge groups exist yet.'}
${existingNames.length ? `The user's existing item names (reuse an exact one via "name" or "group" when it's the same product): ${JSON.stringify(existingNames)}` : ''}`

function reExtract(imgPath, entries, existingNames, groups) {
  const claude = findClaude()
  const out = execFileSync(claude, ['-p', PROMPT(imgPath, entries, existingNames, groups), '--allowedTools', 'Read,WebSearch', '--model', MODEL], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  })
  return lastJsonArray(out)
}

// ---------- apply a re-extracted result to the db ----------

async function deleteImage(entry) {
  if (!entry.path) return
  try {
    const { getStorage } = await import('firebase-admin/storage')
    await getStorage().bucket(BUCKET).file(entry.path).delete()
  } catch { /* already gone / no admin storage — ignore */ }
}

// Resolve the target item for a re-extracted deal: an existing merge group, an
// existing item by name, or a new item. Returns { item, origName }.
function resolveItem(db, r) {
  const isMeat = r.category === 'meat'
  const group = typeof r.group === 'string' && r.group.trim() ? r.group.trim() : null
  const shelf = (r.origName || r.name || '').trim()
  if (group) {
    let item = db.items.find((i) => i.name.trim().toLowerCase() === group.toLowerCase())
    if (!item) {
      item = { id: uid('i'), name: group, category: isMeat ? 'meat' : 'other', kind: kindOf(r.unit), defaultUnit: r.unit, annualQty: null, meatType: null, processing: null, market: null }
      db.items.push(item)
    }
    const origName = shelf && shelf.toLowerCase() !== item.name.toLowerCase() ? shelf : null
    return { item, origName }
  }
  const name = (r.name || shelf).trim()
  let item = db.items.find((i) => i.name.trim().toLowerCase() === name.toLowerCase())
  if (!item) {
    item = { id: uid('i'), name, category: isMeat ? 'meat' : 'other', kind: kindOf(r.unit), defaultUnit: r.unit, annualQty: null, meatType: null, processing: null, market: null }
    db.items.push(item)
  }
  const origName = shelf && shelf.toLowerCase() !== item.name.toLowerCase() ? shelf : null
  return { item, origName }
}

async function applyResult(db, entry, r, summary) {
  if (!r || r.found === false) { summary.unresolved++; return }
  const isMeat = r.category === 'meat'
  const unit = ALL_UNITS.includes(r.unit) ? r.unit : entry.unit
  const price = r.price > 0 ? r.price : entry.price
  const qty = r.qty > 0 ? r.qty : entry.qty
  const minQty = Number.isInteger(r.minQty) && r.minQty >= 2 ? r.minQty : null
  const { item, origName } = resolveItem(db, { ...r, unit })

  // Provisional count item + a real weighted deal -> upgrade (see run.mjs §12).
  const recKind = kindOf(unit)
  if (item.kind === 'count' && recKind !== 'count') { item.kind = recKind; item.defaultUnit = unit }

  // Still no usable size (or a unit that can't sit on this item): keep it in
  // Review, but with the corrected name/price/group so it's easier to finish.
  const byPiece = item.kind !== 'count' && recKind === 'count'
  const canSave = unit !== 'un' && (recKind === item.kind || byPiece)
  if (!canSave) {
    entry.itemName = item.name
    entry.matchedItemId = item.id
    entry.origName = origName
    entry.price = price
    entry.qty = qty
    entry.unit = unit
    entry.category = isMeat ? 'meat' : 'other'
    entry.frozen = isMeat ? !!r.frozen : null
    entry.bones = isMeat ? !!r.bones : null
    entry.skin = isMeat ? !!r.skin : null
    entry.minQty = minQty
    entry.note = unit === 'un' ? 'No weight in the ad — add the real size, or approve as-is.' : entry.note
    summary.updated++
    log(`  review kept: "${item.name}"${origName ? ` (${origName})` : ''} $${price}/${unit}`)
    return
  }

  // Good enough to save as a real price record — mirror the import's record.
  db.records ??= []
  db.records.push({
    id: uid('r'),
    itemId: item.id,
    storeId: entry.storeId,
    price,
    qty,
    unit,
    frozen: isMeat ? !!r.frozen : null,
    bones: isMeat ? !!r.bones : null,
    skin: isMeat ? !!r.skin : null,
    ts: entry.ts ?? Date.now(),
    origName,
    minQty,
    source: 'flyer',
    validUntil: entry.validUntil ?? null,
    flyerUrl: entry.flyerUrl ?? null,
    flyerPage: entry.flyerPage ?? null,
    upcoming: !!entry.upcoming,
  })
  db.photoQueue = (db.photoQueue ?? []).filter((q) => q.id !== entry.id)
  await deleteImage(entry)
  summary.saved++
  log(`  saved: "${item.name}"${origName ? ` (${origName})` : ''} $${price}/${qty}${unit}${minQty ? ` buy${minQty}+` : ''}`)
}

// ---------- main ----------

const env = loadEnv()
if (!env.FAMILY_PASSWORD && !existsSync(join(here, 'service-account.json'))) {
  console.error('Missing credentials: add scripts/flyers/service-account.json or FAMILY_PASSWORD to scripts/flyers/.env')
  process.exit(1)
}

const { db, save } = await openFamilyDoc(env)
if (!db) throw new Error('family db doc not found')

const entries = (db.photoQueue ?? []).filter((q) => q.source === 'flyer' && q.status === 'ready')
if (!entries.length) {
  log('reprocess: no flyer entries in Review')
  process.exit(0)
}
log(`reprocess: ${entries.length} flyer entries in Review${DRY_RUN ? ' (dry run)' : ''}`)

const existingNames = db.items.map((i) => i.name)
const groups = db.items
  .map((i) => ({
    name: i.name,
    members: [...new Set((db.records ?? []).filter((r) => r.itemId === i.id && r.origName).map((r) => r.origName))],
  }))
  .filter((g) => g.members.length)
  .map((g) => ({ name: g.name, members: g.members.slice(0, 8) }))

// Group entries by the page they came from, so each page is read only once.
const pages = new Map()
const skipped = []
for (const e of entries) {
  if (!e.flyerUrl || !e.flyerPage) { skipped.push(e); continue }
  const key = `${e.storeId}|${e.flyerPage}`
  if (!pages.has(key)) pages.set(key, [])
  pages.get(key).push(e)
}
if (skipped.length) log(`reprocess: ${skipped.length} entries have no flyer page link — leaving them in Review`)

const workDir = mkdtempSync(join(tmpdir(), 'spmkt-reprocess-'))
const summary = { saved: 0, updated: 0, unresolved: 0, pageErrors: 0 }
try {
  for (const [key, pageEntries] of pages) {
    const [, page] = key.split('|')
    let imgPath
    try {
      imgPath = await fetchPageImage(pageEntries[0].flyerUrl, Number(page), workDir)
    } catch (err) {
      summary.pageErrors++
      log(`page ${page} (${pageEntries.length} entries): fetch failed (${err.message}) — leaving in Review`)
      continue
    }
    log(`page ${page}: reprocessing ${pageEntries.length} entr${pageEntries.length === 1 ? 'y' : 'ies'} with ${MODEL}`)
    let results
    try {
      results = reExtract(imgPath, pageEntries, existingNames, groups)
    } catch (err) {
      summary.pageErrors++
      log(`page ${page}: Opus failed (${err.message}) — leaving in Review`)
      continue
    } finally {
      if (imgPath && existsSync(imgPath)) unlinkSync(imgPath)
    }
    const byRef = new Map(results.filter((r) => Number.isInteger(r.ref)).map((r) => [r.ref, r]))
    for (let i = 0; i < pageEntries.length; i++) {
      if (DRY_RUN) {
        const r = byRef.get(i)
        log(`  [dry] ref ${i} "${pageEntries[i].origName || pageEntries[i].itemName}" -> ${r ? `${r.found === false ? 'not found' : `${r.name}${r.group ? ` [${r.group}]` : ''} $${r.price}/${r.unit}`}` : 'no result'}`)
        continue
      }
      await applyResult(db, pageEntries[i], byRef.get(i), summary)
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

if (!DRY_RUN && (summary.saved || summary.updated)) await save(db)
log(`reprocess: ${summary.saved} saved as prices, ${summary.updated} corrected in Review, ${summary.unresolved} unresolved, ${summary.pageErrors} page errors`)
process.exit(0)
