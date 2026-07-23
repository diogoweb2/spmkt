// Weekly flyer import: downloads every page of each store's flyer from
// flyers-on-line.com, has Claude (headless) read the images and extract the
// deals, then appends them as price records to the shared family db in
// Firestore. The images are deleted after processing. (Was page-1-only until
// the import whitelist existed to keep the volume sane.)
//
// Usage:
//   node scripts/flyers/run.mjs             # full run (current flyers)
//   node scripts/flyers/run.mjs --upcoming  # import each store's NEXT-week flyer
//   node scripts/flyers/run.mjs --upcoming --retry  # Thursday pass: only the
//                                           # stores deferred by Wednesday's run
//   node scripts/flyers/run.mjs --dry-run   # extract only, print what would be saved
//   node scripts/flyers/run.mjs --force     # re-import stores already done this week
//   node scripts/flyers/run.mjs --url <flyer url> [--store "Name"]
//                                           # one-off import of ANY flyer URL
//                                           # (npm run flyer:custom -- --url ...)
//
// A store whose flyer was already imported in the last 7 days is skipped
// before downloading — no image fetch, no Claude call, no tokens burned.
//
// Config: scripts/flyers/stores.json (one entry per supermarket).
// Secrets: scripts/flyers/.env with FAMILY_PASSWORD=<app password> (gitignored).

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log, loadEnv, findClaude, openFamilyDoc, lastJsonArray, sendPush, uploadReviewImage, flyerImageUrls } from './shared.mjs'
import { classifyMeat } from './classify-meat.mjs'
import { classifyGrocery } from './classify-grocery.mjs'
import { classifyGroceryMarket } from './classify-grocery-market.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
// `--flag value` (or `--flag=value`) reader for the custom-flyer options.
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`))
  return eq ? eq.slice(flag.length + 1) : null
}
// Custom one-off flyer: import a single URL the user pastes, instead of the
// stores.json list. Store name comes from --store, else from a stores.json
// entry whose URL prefixes it, else from the URL slug. Always re-imports (the
// user asked for this specific flyer) and ignores --upcoming/--retry.
const CUSTOM_URL = argValue('--url')
const CUSTOM_STORE = argValue('--store')
const FORCE = process.argv.includes('--force') || !!CUSTOM_URL
// Upcoming-flyer mode: fetch each store's NEXT-week flyer (…/upcoming-flyer)
// instead of the current one, so the user can decide today whether to buy on
// this week's deals or wait. Imported deals are flagged `upcoming` and show an
// 🔜 badge — a reminder they can't be bought yet. Scheduled Wednesday 10:00.
const UPCOMING = !CUSTOM_URL && process.argv.includes('--upcoming')
// Thursday fallback pass: re-runs ONLY the stores whose upcoming flyer wasn't
// published yet on Wednesday (recorded in pending-thursday.json). It retries
// the upcoming flyer and, if still absent, falls back to the current flyer so
// the store isn't skipped entirely. Scheduled Thursday 10:00.
const RETRY = !CUSTOM_URL && process.argv.includes('--retry')
const PENDING_FILE = join(here, 'pending-thursday.json')
// One flyer cycle, minus a day of slack: last week's run may have finished
// later in the day than this week's (machine asleep at 9:30, manual re-run),
// and a strict 8-day window would then skip the whole scheduled run.
const WEEK_MS = 7 * 24 * 3600 * 1000
const UNITS = { weight: ['kg', 'g', 'lb', 'oz'], volume: ['L', 'ml'], count: ['un'] }

// ---------- download ----------

// "Valid from July 9 to 15, 2026" / "Valid from June 30 to July 6, 2026" ->
// timestamp of the last valid day, end of day. null if not found.
function parseValidUntil(html) {
  const m = html.match(/Valid from\s+([A-Za-z]+)\s+\d{1,2}\s+to\s+(?:([A-Za-z]+)\s+)?(\d{1,2}),?\s+(\d{4})/)
  if (!m) return null
  const dt = new Date(`${m[2] || m[1]} ${m[3]}, ${m[4]} 23:59:59`)
  return isNaN(dt) ? null : dt.getTime()
}

async function downloadPages(store, dir, url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`)
  const html = await res.text()
  const validUntil = parseValidUntil(html)
  // Page images are /data/promotions/<id>/<slug>_NN.jpg. The suffix is NOT the
  // display order — Superstore's first page is _07, with _01.._06 being ad
  // inserts. The site renders pages in document order, so we keep the URLs in
  // the order they appear in the HTML (deduped: each page is referenced twice).
  // Shared with reprocess-review.mjs so both number the pages identically
  // (it dedupes on the URL without its ?v= cachebuster — see shared.mjs).
  const urls = flyerImageUrls(html)
  if (!urls.length) throw new Error(`no flyer page images found at ${url}`)
  const files = []
  for (const [i, imgUrl] of urls.entries()) {
    try {
      const imgRes = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: url } })
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
      const file = join(dir, `${store.name.toLowerCase().replace(/\W+/g, '-')}-page${String(i + 1).padStart(2, '0')}.jpg`)
      writeFileSync(file, Buffer.from(await imgRes.arrayBuffer()))
      files.push(file)
    } catch (err) {
      log(`${store.name}: page ${i + 1} download failed (${err.message}) — skipping that page`)
    }
  }
  if (!files.length) throw new Error(`all ${urls.length} page downloads failed for ${url}`)
  log(`${store.name}: downloaded ${files.length}/${urls.length} pages (valid until ${validUntil ? new Date(validUntil).toDateString() : 'unknown'})`)
  // pageCount = urls.length, not files.length: a failed download skips a file
  // but the remaining filenames keep their true page numbers.
  return { files, validUntil, pageCount: urls.length }
}

// ---------- claude extraction ----------

// One call per BATCH of pages (see PAGES_PER_CALL): the rules and db item
// names are re-paid per batch, but a whole flyer in a single call made the
// model skim and miss most of the deals.
const EXTRACT_PROMPT = (imgPaths, existingNames, ignoredNames, whitelist, groups = []) => `Use the Read tool to open ${imgPaths.length === 1 ? 'this image file' : `these ${imgPaths.length} image files, one by one`} — they are the pages of one supermarket flyer and you CAN view images via the Read tool:
${imgPaths.join('\n')}

Extract every grocery deal from ALL pages combined. Output ONLY a single JSON array (no prose, no markdown fence). If the same product appears on more than one page, output it once. Each element:
{"name": string, "origName": string, "category": "meat"|"other", "price": number, "qty": number, "unit": "kg"|"g"|"lb"|"oz"|"L"|"ml"|"un", "frozen": boolean|null, "bones": boolean|null, "skin": boolean|null, "minQty": number|null, "file": string, "page": number}

Rules:
- file: the FULL PATH of the image file this deal was read from, copied EXACTLY from the list above. This is how the user is shown the right ad page — a wrong path shows them the wrong page, so copy the path of the file you were actually looking at when you saw this deal. Never guess it, never reuse the previous element's path out of habit.
- page: the NN number in that same file's name ("...-pageNN.jpg" -> page NN). It must match "file". If a product appears on several pages, use the first.
- name: clean generic product name with brand if shown (e.g. "Chicken Drumsticks", "Coca-Cola 12-pack"). No sizes/prices in the name.
- origName: the product name exactly as printed on the flyer (brand, variety, wording — still no sizes/prices). This is what the user reads on the shelf, so keep it faithful even when "name" is a generic/db name that groups it with similar products.
- price is in dollars for the stated qty+unit. "$2.99/lb" -> price 2.99, qty 1, unit "lb". "2 for $5" -> price 2.50, qty 1, unit "un", minQty 2. A 1.89 L juice at $3.99 -> price 3.99, qty 1.89, unit "L". If sold by weight/volume use that unit; packaged goods with no usable size -> unit "un", qty 1.
- MEMBER / LOYALTY PRICE — the shopper is a member of EVERY store. Many flyers print TWO prices: a lower member/card price (labelled "MEMBER", "MEMBER PRICING", "member price", "with card", or a loyalty brand — Scene+, Moi, PC Optimum, More Rewards, AIR MILES) and a higher regular price ("without Scene+ Card", "non-member", "non moi price", "regular"). ALWAYS record the MEMBER price (the lower one), never the regular price. E.g. "MEMBER ONLY 11.99/lb · without Scene+ Card 12.99/lb" -> price 11.99. "moi price 1.98 · non moi price 2.50" -> price 1.98, minQty null.
- PRICED BY WEIGHT (/lb or /kg) — if a price shows "/lb", " lb", "/kg" or " kg" next to it (e.g. "12.99/lb  28.64/kg"), the product is sold BY WEIGHT: use unit "lb" with qty 1 when "/lb" is shown (else "kg", qty 1). NEVER output "un" for a product that has a per-lb or per-kg price — almost all fresh meat, deli and loose produce is priced this way, so read the "/lb" or "/kg" and use it.
- minQty — multi-buy deals ("2 for $5", "2/$2.50", "3/$10", "buy 2 or more"): price = the PER-ITEM deal price and minQty = the minimum count the shopper must buy to get it (2, 2, 3, 2 in those examples). When the flyer also shows a single-item price ("2/$2.50 OR $1.50 EA"), record the multi-buy price with its minQty (price 1.25, minQty 2 there) — the multi-buy is the deal. If each item has a printed size, qty+unit still describe ONE item ("2/$7" on 500 g boxes -> price 3.50, qty 500, unit "g", minQty 2). Normal prices with no minimum -> minQty null.
- ALWAYS PREFER A WEIGHT/VOLUME OVER "un". "un" is the LAST RESORT, only when no size can be found anywhere. Work in this order: (1) read the size from the flyer TEXT/title; (2) if the title shows a RANGE of sizes ("210/235 G", "210-235 g", "SELECTED VARIETIES 210/235 G"), it means the varieties come in different sizes — pick the LOWER number (210 g here); (3) if the title has no size, READ THE SIZE OFF THE PRODUCT IMAGE — packaged goods almost always print the net weight on the bag/box (e.g. "235 g" on a chip bag), so open the image and look; (4) if there is still no size, LOOK UP THE STANDARD RETAIL SIZE with the WebSearch tool (see next rule); (5) only if the lookup gives no confident answer, fall back to unit "un".
- STANDARD SIZE LOOKUP (WebSearch) — packaged and processed products are sold in very standard sizes, so when steps (1)-(3) found no size you MUST use the WebSearch tool to find the normal Canadian retail size for that exact product, e.g. search "Oikos 4 pack yogurt weight" -> 4 x 100 g = qty 400 unit "g"; "Activia tub 650 g"; "Miss Vickie's chips bag size". Use the pack count VISIBLE IN THE AD (the Oikos photo shows 4 cups -> multiply the per-cup size by 4). Only accept a size you find stated for that brand/product; if results disagree or are vague, do NOT guess — fall back to "un".
  · ALLOWED for: packaged/boxed/bottled groceries, and PROCESSED meat & fish (bacon, sausages, deli slices, nuggets, breaded fish, frozen boxes).
  · NEVER for: fresh/natural meat, poultry, fish and loose produce — those have no standard size, so never search or guess a weight for them.
- The item kinds must stay consistent: weight units (kg/g/lb/oz) only when a weight is printed or the price is per weight.
- Packaged/boxed products (frozen meat boxes, nuggets, wings, breaded fish, burgers, ice cream tubs...): ALWAYS use the printed package size as qty+unit (e.g. 750 g box -> qty 750 unit "g"; 1.1 kg -> qty 1.1 unit "kg") so different box sizes are comparable across stores. If a multi-product deal shows a different size per product, use each product's own size.
- NEVER invent or estimate a weight/volume — but a size printed ON THE PRODUCT IMAGE (net weight on the bag/box) IS printed on the flyer, so reading it off the image is required; and a standard retail size CONFIRMED BY WebSearch for a packaged/processed product is a looked-up fact, not an invention. If a product is priced by piece or by package with no size printed anywhere (not in the text and not visible on the image) (e.g. "BONELESS SKINLESS CHICKEN BREAST, 3 piece — ONLY $8", "2 for $5"), use unit "un" with qty = the number of pieces/items (3 and 1 in those examples). This applies to meat too: "3 piece $8" -> price 8, qty 3, unit "un", category "meat". A wrong guessed weight is far worse than an honest per-piece price.
- EXCEPTION to the above: berries (blueberries, raspberries, blackberries, strawberries when sold as a "pint") printed as "pint" with no weight -> a pint is a standard retail unit, use qty 340 unit "g". This is the one container size allowed to be converted without a printed weight.
- SPLIT COMBINED DEALS — one flyer ad very often covers SEVERAL distinct products under a single price. Output ONE ELEMENT PER PRODUCT, each with the same price, never a single merged element. Watch for these signals in the title: the words "OR" / "OU", commas listing brands, and several different packages shown in the photo.
  · "GENERAL MILLS CEREAL, ACTIVIA TUBS OR OIKOS 4'S YOGURT — $3.49 ea" -> THREE elements: General Mills Cheerios cereal, Activia yogurt tub, Oikos 4-pack yogurt, each price 3.49.
  · "TOSTITOS TORTILLA CHIPS OR MISS VICKIE'S CHIPS" -> two elements (one per brand).
  · "pork loin or chicken thighs $3.99/lb" -> two elements.
  Each split product gets its OWN name/origName and its OWN size: read each package's size from the ad text or its own photo, and look it up per product when absent (size rules above). Never copy one product's weight onto another. Only merge into one element when the ad is genuinely a single product with variety names ("selected varieties" of the same item).
- Meat/fish/poultry items — including processed ones (breaded fish, nuggets, sausages, deli): category "meat" and infer the variant from the text/photo: skin (skin-on true / skinless false), bones (bone-in true / boneless false), frozen (true/false). Use your best judgment from wording like "skinless", "boneless", "frozen", "fresh", "back attached"; if truly undeterminable use false for frozen and your best visual guess for skin/bones. Non-meat items: frozen/bones/skin all null.
- Skip anything that is not a grocery product you'd buy to eat or use in the kitchen/home: store banners, event ads, store hours, loyalty-points promos with no concrete product price, toys, clothing, electronics, kitchenware, pet food, garden. If the page turns out to be a pure advertisement with no priced groceries, return an empty array [].
- If a price is unreadable, skip that product.${existingNames.length ? `
- The db already has these items — if a flyer product is THE SAME PRODUCT as one of these, use that EXACT name (so its price history continues) instead of inventing a new variation; origName still keeps the flyer's own wording: ${JSON.stringify(existingNames)}
  CRITICAL: only reuse a name when it is genuinely the same product. A different cut, species, or product type MUST get its own name, even when an existing name looks similar — chicken wings are NOT chicken thighs, pork loin chops are NOT pork shoulder blade chops, breaded chicken strips are NOT smoked sausages, strip loin steak is NOT ground beef. When no existing name is truly the same product, write a new accurate name from the flyer wording. A wrong reuse corrupts another product's price history, which is far worse than one extra item.` : ''}${groups.length ? `
- MERGE GROUPS — the user groups similar products under one shared name so they compare side by side. Each group below lists its shared "name" and example shelf products already inside it. If a flyer product clearly belongs to a group (same product category as its members — e.g. any potato/tortilla chips -> a "Chips" group; any cheese -> a "Cheese" group; any yogurt -> a "Yogurt" group), set "name" to the group's EXACT shared name and keep the flyer's own wording in origName. Only route into a group when the product genuinely fits it; when unsure, use a normal specific name instead. Groups: ${JSON.stringify(groups)}` : ''}${ignoredNames.length ? `
- IGNORED PRODUCTS — the user deleted these and never wants to see them again: ${JSON.stringify(ignoredNames)}
  Each name is an EXAMPLE of a product type, not a string to match on. Work out what the product actually IS — its generic type, dropping the brand, the size and any qualifier — then omit every flyer product of that type, whatever its brand or variety.
  · "Royale Bathroom Tissue" -> the type is bathroom tissue: omit all bathroom tissue, any brand.
  · "Robin Hood All Purpose Flour" -> the type is flour: omit all flour (all-purpose, bread, whole wheat, cake, any brand) — but KEEP other Robin Hood products such as oats.
  · "Farmer's Market Pies" -> the type is pies: omit all pies, any brand or flavour.
  Do not over-generalize either: a genuinely different product that merely shares a brand, a word or a shelf stays IN (paper towels are not bathroom tissue; a cheesecake is not a pie; pizza pockets are not flour). If in doubt, keep the product.` : ''}${whitelist.length ? `
- WHITELIST — the user only wants these kinds of products (plus all meat): ${JSON.stringify(whitelist)}
  Apply this to every NON-MEAT product: include it only if it matches at least one rule; omit every other non-meat product. Rules are plain language and may carry exceptions — honor them exactly:
  · "Yogurt but only Greek style" -> include Greek yogurt of any brand, omit every other yogurt.
  · "Chips but not Pringles" -> include chips of any brand except Pringles.
  · "all fruits but not organic" -> include fruit, omit anything labeled organic.
  Meat/fish/poultry (category "meat") are EXEMPT: always include them regardless of the whitelist.
  If an IGNORED PRODUCTS rule above conflicts with the whitelist, the ignore wins: an ignored product type stays out.` : ''}`

// Pages per Claude call. A 17-page flyer in ONE call made the model skim — it
// returned ~30 deals for a flyer holding far more. Batching a few pages per
// call keeps recall high; the prompt overhead (rules + db item names) is then
// paid once per batch instead of once per store, which is the price of not
// missing deals. Override with --pages-per-call N.
// Small batches also keep PAGE ATTRIBUTION honest: the fewer pages in a call,
// the less chance a deal is tagged with a neighbouring page (which then shows
// the wrong ad image in Review).
const PAGES_PER_CALL = Number(argValue('--pages-per-call')) || 2

function extractProducts(imgPaths, storeName, existingNames, ignoredNames, whitelist, groups = []) {
  const claude = findClaude()
  const batches = []
  for (let i = 0; i < imgPaths.length; i += PAGES_PER_CALL) batches.push(imgPaths.slice(i, i + PAGES_PER_CALL))
  log(`${storeName}: extracting ${imgPaths.length} page${imgPaths.length === 1 ? '' : 's'} in ${batches.length} call${batches.length === 1 ? '' : 's'} with ${claude}`)
  const allUnits = Object.values(UNITS).flat()
  const products = []
  const seen = new Set()
  for (const [n, batch] of batches.entries()) {
    let parsed = []
    try {
      const out = execFileSync(claude, ['-p', EXTRACT_PROMPT(batch, existingNames, ignoredNames, whitelist, groups),
        // WebSearch: standard retail sizes for packaged/processed products whose
        // size isn't printed in the ad (e.g. Oikos 4-pack = 400 g).
        // Sonnet at low effort: Haiku skimmed pages, misread sizes and reused
        // wrong item names. Batched pages keep the cost sane.
        '--allowedTools', 'Read,WebSearch', '--model', 'claude-sonnet-5', '--effort', 'low'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      })
      parsed = lastJsonArray(out)
    } catch (err) {
      // One bad batch must not cost the whole flyer.
      log(`${storeName}: batch ${n + 1}/${batches.length} failed (${err.message}) — skipping those pages`)
      continue
    }
    // Page attribution: trust the file path the model copied back, not the
    // number it typed — the page drives which ad image the Review card shows,
    // and a wrong page showed the user a useless image. A deal whose file/page
    // isn't one of THIS batch's pages gets page null (no image) rather than a
    // confidently wrong one; a single-page batch can only be that page.
    const pagesInBatch = new Map() // "-pageNN.jpg" -> NN, for this batch only
    for (const f of batch) {
      const m = f.match(/-page(\d+)\.jpg$/)
      if (m) pagesInBatch.set(f, Number(m[1]))
    }
    const only = pagesInBatch.size === 1 ? [...pagesInBatch.values()][0] : null
    const valid = parsed
      .filter((p) => p && p.name && p.price > 0 && p.qty > 0 && allUnits.includes(p.unit))
      .map((p) => {
        const fromFile = typeof p.file === 'string' ? pagesInBatch.get(p.file.trim()) : undefined
        const fromNum = [...pagesInBatch.values()].includes(p.page) ? p.page : undefined
        return { ...p, page: fromFile ?? fromNum ?? only ?? null }
      })
    const noPage = valid.filter((p) => p.page == null).length
    log(`${storeName}: batch ${n + 1}/${batches.length} -> ${valid.length} deals${noPage ? ` (${noPage} with no reliable page)` : ''}`)
    for (const p of valid) {
      // Same product seen again in another batch (or on another page): keep the first.
      const key = `${(p.origName || p.name).trim().toLowerCase()}|${p.price}`
      if (seen.has(key)) continue
      seen.add(key)
      products.push(p)
    }
  }
  return products
}

// ---------- firestore insert ----------

function kindOf(unit) {
  return Object.keys(UNITS).find((k) => UNITS[k].includes(unit))
}

async function insertProducts(products, storeName, env, validUntil, flyerUrl, pageCount, upcoming, pageFiles = new Map()) {
  const { db, save } = await openFamilyDoc(env)
  if (!db) throw new Error('family db doc not found')
  db.stores ??= []
  db.items ??= []
  db.records ??= []

  const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  let store = db.stores.find((s) => s.name.toLowerCase() === storeName.toLowerCase())
  if (!store) {
    store = { id: uid('s'), name: storeName, color: '#16a34a', defaultUnit: 'lb' }
    db.stores.push(store)
  }

  const weekAgo = Date.now() - WEEK_MS
  // Backstop for the semantic skip in the prompt: never re-create an item the
  // user deleted & ignored by that exact name.
  const ignored = new Set((db.ignored ?? []).map((g) => g.name.trim().toLowerCase()))
  let added = 0
  for (const p of products) {
    if (ignored.has(p.name.trim().toLowerCase())) {
      log(`  skip "${p.name}": ignored product`)
      continue
    }
    const isMeat = p.category === 'meat'
    let item = db.items.find((i) => i.name.trim().toLowerCase() === p.name.trim().toLowerCase())
    if (!item) {
      // meatType/processing/market stay null here — the classify-meat pass
      // that runs after the import fills them in.
      item = { id: uid('i'), name: p.name.trim(), category: isMeat ? 'meat' : 'other', kind: kindOf(p.unit), defaultUnit: p.unit, annualQty: null, meatType: null, processing: null, market: null }
      db.items.push(item)
    }
    const recKind = kindOf(p.unit)
    const flyerPage = Number.isInteger(p.page) && p.page >= 1 && p.page <= pageCount ? p.page : null
    const origName =
      typeof p.origName === 'string' && p.origName.trim() && p.origName.trim().toLowerCase() !== item.name.trim().toLowerCase()
        ? p.origName.trim()
        : null

    // Park a product in the Review inbox (photoQueue, status 'ready') instead of
    // saving it — for `un` deals with no size, and for extraction slips whose
    // unit doesn't fit the item. The flyer page image is uploaded and linked so
    // the user can read the real size and fix it. Deduped by item+store+week
    // across both records and already-queued flyer entries. See §12/§15.
    const queueReview = async (unit, note) => {
      const already =
        db.records.some((r) => r.source === 'flyer' && r.itemId === item.id && r.storeId === store.id && r.ts > weekAgo) ||
        (db.photoQueue ?? []).some((q) => q.source === 'flyer' && q.matchedItemId === item.id && q.storeId === store.id && q.ts > weekAgo)
      if (already) return false
      const id = uid('p')
      let path = null
      const localPath = flyerPage ? pageFiles.get(flyerPage) : null
      if (localPath) {
        try {
          path = await uploadReviewImage(env, localPath, id)
        } catch (err) {
          log(`  "${p.name}": review image upload failed (${err.message})`)
        }
      }
      db.photoQueue ??= []
      db.photoQueue.push({
        id,
        path,
        storeId: store.id,
        status: 'ready',
        ts: Date.now(),
        itemName: item.name,
        matchedItemId: item.id,
        price: p.price,
        qty: p.qty,
        unit,
        category: isMeat ? 'meat' : 'other',
        frozen: isMeat ? !!p.frozen : null,
        bones: isMeat ? !!p.bones : null,
        skin: isMeat ? !!p.skin : null,
        processing: null,
        groceryType: isMeat ? null : (item.groceryType ?? null),
        minQty: Number.isInteger(p.minQty) && p.minQty >= 2 ? p.minQty : null,
        note,
        origName,
        source: 'flyer',
        validUntil: validUntil ?? null,
        flyerUrl: flyerUrl ?? null,
        flyerPage,
        upcoming: !!upcoming,
      })
      return true
    }

    // An item created from earlier by-piece/`un` imports is a provisional
    // `count` item with no real weight/volume history. A genuine weighted deal
    // now upgrades it to that kind so it imports as a comparable record — the
    // old `un` placeholders just become by-piece references on the new kind
    // (reference-only, §3), which is exactly how the app already treats them.
    if (item.kind === 'count' && recKind !== 'count') {
      item.kind = recKind
      item.defaultUnit = p.unit
      log(`  "${item.name}": upgraded by-piece item to ${recKind} (${p.unit})`)
    }

    // `un` means no size was found in the flyer text OR the product image — the
    // extractor's last resort (§12). Park it in Review to add the real weight.
    if (p.unit === 'un') {
      if (await queueReview('un', 'No weight in the ad — add the real size, or approve as-is.')) added++
      continue
    }
    // A count unit on a weight/volume item is a legit by-piece price (§3).
    // Any OTHER kind clash (e.g. a volume unit on a weight item) is an
    // extraction slip — don't drop it; park it in Review with the ad image.
    const byPiece = item.kind !== 'count' && recKind === 'count'
    if (recKind !== item.kind && !byPiece) {
      log(`  "${p.name}": unit ${p.unit} doesn't fit ${item.kind} item — sending to Review`)
      if (await queueReview(p.unit, `Unit "${p.unit}" didn't match this ${item.kind} product — check the size in the ad.`)) added++
      continue
    }
    const rec = {
      id: uid('r'),
      itemId: item.id,
      storeId: store.id,
      price: p.price,
      qty: p.qty,
      unit: p.unit,
      frozen: isMeat ? !!p.frozen : null,
      bones: isMeat ? !!p.bones : null,
      skin: isMeat ? !!p.skin : null,
      ts: Date.now(),
      // Flyer's literal product name, kept only when it differs from the item
      // name (which may be a generic/db name grouping similar products).
      origName,
      // Multi-buy deals ("2/$2.50"): price is per item, minQty = how many the
      // shopper must buy to get it. Indicator only — comparisons are unchanged.
      minQty: Number.isInteger(p.minQty) && p.minQty >= 2 ? p.minQty : null,
      source: 'flyer',
      validUntil: validUntil ?? null,
      // The app links the 📰 badge to the flyer site — #p=<page> when the
      // extraction reported which page the deal was on, plain URL otherwise.
      flyerUrl: flyerUrl ?? null,
      flyerPage,
      // Imported from the store's upcoming (next-week) flyer: the app shows an
      // 🔜 badge so the user knows the deal can't be bought yet.
      upcoming: !!upcoming,
    }
    // Dedupe: flyers are weekly, so at most one flyer record per item+store
    // per week — extraction can vary run to run (names, meat classification),
    // and a store never has two flyer deals for the same item in one week.
    const dup = db.records.some((r) =>
      r.source === 'flyer' && r.itemId === rec.itemId && r.storeId === rec.storeId && r.ts > weekAgo)
    if (dup) continue
    db.records.push(rec)
    added++
  }
  await save(db)
  log(`${storeName}: saved ${added} new records (${products.length - added} skipped as dupes/invalid)`)
  return added
}

// ---------- main ----------

const stores = JSON.parse(readFileSync(join(here, 'stores.json'), 'utf8'))
const env = loadEnv()
if (!DRY_RUN && !env.FAMILY_PASSWORD && !existsSync(join(here, 'service-account.json'))) {
  console.error('Missing credentials: add scripts/flyers/service-account.json (preferred) or FAMILY_PASSWORD to scripts/flyers/.env')
  process.exit(1)
}

// The Thursday retry pass runs only the stores whose upcoming flyer wasn't up
// on Wednesday. If none were deferred, there is nothing to do.
let storesToRun = stores
if (CUSTOM_URL) {
  const known = stores.find((s) => CUSTOM_URL.toLowerCase().startsWith(s.url.toLowerCase()))
  const slug = (CUSTOM_URL.match(/flyers-on-line\.com\/([^/?#]+)/i)?.[1] ?? 'Custom Flyer')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  const name = CUSTOM_STORE || known?.name || slug
  storesToRun = [{ name, url: CUSTOM_URL }]
  log(`Custom flyer import: "${name}" <- ${CUSTOM_URL}`)
} else if (RETRY) {
  const deferred = existsSync(PENDING_FILE) ? JSON.parse(readFileSync(PENDING_FILE, 'utf8')) : []
  storesToRun = stores.filter((s) => deferred.includes(s.name))
  if (!storesToRun.length) {
    log('No stores were deferred to Thursday — nothing to retry.')
    process.exit(0)
  }
  log(`Thursday retry for: ${storesToRun.map((s) => s.name).join(', ')}`)
}

// The URL(s) to try for a store, in order. Upcoming mode fetches the next-week
// flyer; the Thursday retry pass also falls back to the current flyer so a
// store whose upcoming flyer is still absent isn't skipped for the week.
const urlCandidates = (store) => {
  if (!UPCOMING) return [{ url: store.url, upcoming: false }]
  const cands = [{ url: `${store.url}/upcoming-flyer`, upcoming: true }]
  if (RETRY) cands.push({ url: store.url, upcoming: false })
  return cands
}

const workDir = mkdtempSync(join(tmpdir(), 'spmkt-flyers-'))
let failed = false
const results = [] // { name, added?, skipped?, deferred?, error? }
const deferToThursday = [] // Wednesday: stores whose upcoming flyer wasn't up yet
for (const store of storesToRun) {
  const imgs = []
  try {
    let existingNames = []
    let groups = []
    let ignoredNames = []
    let whitelist = []
    if (!DRY_RUN) {
      const { db } = await openFamilyDoc(env)
      // Already imported this week? Skip before spending a download + tokens.
      const s = db?.stores?.find((x) => x.name.toLowerCase() === store.name.toLowerCase())
      const last = s && db.records
        .filter((r) => r.source === 'flyer' && r.storeId === s.id)
        .reduce((max, r) => Math.max(max, r.ts), 0)
      if (last && Date.now() - last < WEEK_MS && !FORCE) {
        log(`${store.name}: already imported ${new Date(last).toLocaleString()} — skipping (use --force to re-import)`)
        results.push({ name: store.name, skipped: true })
        continue
      }
      existingNames = db?.items?.map((i) => i.name) ?? []
      // Merge groups: items that already fold several shelf names together
      // (records with an origName). Passed to the extractor so a new flyer
      // product of the same kind routes INTO the group by reusing its name,
      // instead of spawning a near-duplicate item (§12 auto-grouping).
      groups = (db?.items ?? [])
        .map((i) => ({
          name: i.name,
          members: [...new Set((db.records ?? []).filter((r) => r.itemId === i.id && r.origName).map((r) => r.origName))],
        }))
        .filter((g) => g.members.length)
        .map((g) => ({ name: g.name, members: g.members.slice(0, 10) }))
      ignoredNames = db?.ignored?.map((g) => g.name) ?? []
      // Import whitelist (Settings): only active when toggled on AND non-empty
      // — never lets an empty list silently import nothing. Meat is exempt.
      if (db?.whitelistOn && db?.whitelist?.length) whitelist = db.whitelist.map((r) => r.text)
    }
    // Try the candidate URLs in order (upcoming flyer, then current flyer on
    // the Thursday retry). The first that downloads wins.
    let dl, chosen, lastErr
    for (const c of urlCandidates(store)) {
      try {
        dl = await downloadPages(store, workDir, c.url)
        chosen = c
        break
      } catch (err) {
        lastErr = err
        log(`${store.name}: ${c.upcoming ? 'upcoming' : 'current'} flyer unavailable (${err.message})`)
      }
    }
    if (!dl) {
      // Wednesday and the upcoming flyer isn't published yet: defer this store
      // to Thursday's retry pass instead of failing the run.
      if (UPCOMING && !RETRY) {
        deferToThursday.push(store.name)
        log(`${store.name}: upcoming flyer not up yet — deferring to Thursday`)
        results.push({ name: store.name, deferred: true })
        continue
      }
      throw lastErr
    }
    imgs.push(...dl.files)
    // One Claude call per store, all pages at once (token efficiency). Any
    // cross-page or re-run duplicates are handled by insertProducts'
    // one-flyer-record-per-item+store-per-week dedupe.
    const products = extractProducts(dl.files, store.name, existingNames, ignoredNames, whitelist, groups)
    log(`${store.name}: extracted ${products.length} products from ${dl.files.length} pages`)
    if (DRY_RUN) {
      console.log(JSON.stringify(products, null, 2))
    } else {
      // page number -> local image file, so review-bound products can attach
      // the flyer page (filenames end "-pageNN.jpg", NN = the flyer page).
      const pageFiles = new Map()
      for (const f of dl.files) {
        const m = f.match(/-page(\d+)\.jpg$/)
        if (m) pageFiles.set(Number(m[1]), f)
      }
      const added = await insertProducts(products, store.name, env, dl.validUntil, chosen.url, dl.pageCount, chosen.upcoming, pageFiles)
      results.push({ name: store.name, added })
    }
  } catch (err) {
    failed = true
    results.push({ name: store.name, error: err.message })
    console.error(`[${store.name}] FAILED: ${err.message}`)
  } finally {
    for (const f of imgs) if (existsSync(f)) unlinkSync(f)
  }
}
rmSync(workDir, { recursive: true, force: true })

// Record which stores need the Thursday retry (Wednesday run), or clear the
// list once Thursday has had its final attempt at them.
if (!DRY_RUN) {
  if (UPCOMING && !RETRY) {
    if (deferToThursday.length) writeFileSync(PENDING_FILE, JSON.stringify(deferToThursday, null, 2))
    else if (existsSync(PENDING_FILE)) unlinkSync(PENDING_FILE)
  } else if (RETRY && existsSync(PENDING_FILE)) {
    unlinkSync(PENDING_FILE)
  }
}

// After the imports: classify new meat items (type, natural vs ultra-processed)
// and refresh the Toronto market thresholds the app rates deals against.
let classifyFailed = false
if (!DRY_RUN) {
  try {
    await classifyMeat(env)
  } catch (err) {
    failed = true
    classifyFailed = true
    console.error(`[classify-meat] FAILED: ${err.message}`)
  }
  // ...and label new non-meat items with their supermarket section
  // (groceryType) for Home's Groceries category filter.
  try {
    await classifyGrocery(env)
  } catch (err) {
    failed = true
    classifyFailed = true
    console.error(`[classify-grocery] FAILED: ${err.message}`)
  }
  // ...and research market thresholds for non-meat items that have none yet,
  // so grocery deals get excellent/good/average/bad ratings like meat.
  try {
    await classifyGroceryMarket(env)
  } catch (err) {
    failed = true
    classifyFailed = true
    console.error(`[classify-grocery-market] FAILED: ${err.message}`)
  }
}

// Notify every registered device with a summary of this run.
if (!DRY_RUN) {
  try {
    const imported = results.filter((r) => r.added != null)
    const errored = results.filter((r) => r.error)
    const skipped = results.filter((r) => r.skipped)
    const deferred = results.filter((r) => r.deferred)
    const totalAdded = imported.reduce((s, r) => s + r.added, 0)
    const kind = UPCOMING ? '🔜 Upcoming flyer sync' : 'Flyer sync'
    const title = failed ? `⚠️ ${kind} finished with errors` : `✅ ${kind} done`
    const parts = [`${totalAdded} new deal${totalAdded === 1 ? '' : 's'} from ${imported.length} store${imported.length === 1 ? '' : 's'}.`]
    if (errored.length) parts.push(`Failed: ${errored.map((r) => r.name).join(', ')}.`)
    if (classifyFailed) parts.push('Classification failed.')
    if (skipped.length) parts.push(`${skipped.length} already up to date.`)
    if (deferred.length) parts.push(`${deferred.map((r) => r.name).join(', ')} deferred to Thursday.`)
    await sendPush(env, { title, body: parts.join(' ') })
  } catch (err) {
    console.error(`[push] FAILED: ${err.message}`)
  }
}
process.exit(failed ? 1 : 0)
