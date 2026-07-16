// Weekly flyer import: downloads every page of each store's flyer from
// flyers-on-line.com, has Claude (headless) read the images and extract the
// deals, then appends them as price records to the shared family db in
// Firestore. The images are deleted after processing. (Was page-1-only until
// the import whitelist existed to keep the volume sane.)
//
// Usage:
//   node scripts/flyers/run.mjs            # full run
//   node scripts/flyers/run.mjs --dry-run  # extract only, print what would be saved
//   node scripts/flyers/run.mjs --force    # re-import stores already done this week
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
import { log, loadEnv, findClaude, openFamilyDoc, lastJsonArray, sendPush } from './shared.mjs'
import { classifyMeat } from './classify-meat.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')
// One flyer cycle, minus a day of slack: last week's run may have finished
// later in the day than this week's (machine asleep at 9:30, manual re-run),
// and a strict 7-day window would then skip the whole scheduled run.
const WEEK_MS = 6 * 24 * 3600 * 1000
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

async function downloadPages(store, dir) {
  const res = await fetch(store.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`fetch ${store.url}: HTTP ${res.status}`)
  const html = await res.text()
  const validUntil = parseValidUntil(html)
  // Page images are /data/promotions/<id>/<slug>_NN.jpg. The suffix is NOT the
  // display order — Superstore's first page is _07, with _01.._06 being ad
  // inserts. The site renders pages in document order, so we keep the URLs in
  // the order they appear in the HTML (deduped: each page is referenced twice).
  const urls = [...new Set(
    [...html.matchAll(/https:\/\/www\.flyers-on-line\.com\/data\/promotions\/\d+\/[^"' ]+_\d{2}\.jpg[^"' ]*/g)]
      .map((m) => m[0]),
  )]
  if (!urls.length) throw new Error(`no flyer page images found at ${store.url}`)
  const files = []
  for (const [i, url] of urls.entries()) {
    try {
      const imgRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: store.url } })
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
      const file = join(dir, `${store.name.toLowerCase().replace(/\W+/g, '-')}-page${String(i + 1).padStart(2, '0')}.jpg`)
      writeFileSync(file, Buffer.from(await imgRes.arrayBuffer()))
      files.push(file)
    } catch (err) {
      log(`${store.name}: page ${i + 1} download failed (${err.message}) — skipping that page`)
    }
  }
  if (!files.length) throw new Error(`all ${urls.length} page downloads failed for ${store.url}`)
  log(`${store.name}: downloaded ${files.length}/${urls.length} pages (valid until ${validUntil ? new Date(validUntil).toDateString() : 'unknown'})`)
  return { files, validUntil }
}

// ---------- claude extraction ----------

const EXTRACT_PROMPT = (imgPath, existingNames, ignoredNames, whitelist) => `Use the Read tool to open the image file ${imgPath} — it is a supermarket flyer page and you CAN view images via the Read tool. Then extract every grocery deal on it.

Output ONLY a JSON array (no prose, no markdown fence). Each element:
{"name": string, "category": "meat"|"other", "price": number, "qty": number, "unit": "kg"|"g"|"lb"|"oz"|"L"|"ml"|"un", "frozen": boolean|null, "bones": boolean|null, "skin": boolean|null}

Rules:
- name: clean generic product name with brand if shown (e.g. "Chicken Drumsticks", "Coca-Cola 12-pack"). No sizes/prices in the name.
- price is in dollars for the stated qty+unit. "$2.99/lb" -> price 2.99, qty 1, unit "lb". "2 for $5" -> price 2.50, qty 1, unit "un". A 1.89 L juice at $3.99 -> price 3.99, qty 1.89, unit "L". If sold by weight/volume use that unit; packaged goods with no usable size -> unit "un", qty 1.
- The item kinds must stay consistent: weight units (kg/g/lb/oz) only when a weight is printed or the price is per weight.
- Packaged/boxed products (frozen meat boxes, nuggets, wings, breaded fish, burgers, ice cream tubs...): ALWAYS use the printed package size as qty+unit (e.g. 750 g box -> qty 750 unit "g"; 1.1 kg -> qty 1.1 unit "kg") so different box sizes are comparable across stores. If a multi-product deal shows a different size per product, use each product's own size.
- NEVER invent or estimate a weight/volume that is not printed on the flyer. If a product is priced by piece or by package with no size printed (e.g. "BONELESS SKINLESS CHICKEN BREAST, 3 piece — ONLY $8", "2 for $5"), use unit "un" with qty = the number of pieces/items (3 and 1 in those examples). This applies to meat too: "3 piece $8" -> price 8, qty 3, unit "un", category "meat". A wrong guessed weight is far worse than an honest per-piece price.
- EXCEPTION to the above: berries (blueberries, raspberries, blackberries, strawberries when sold as a "pint") printed as "pint" with no weight -> a pint is a standard retail unit, use qty 340 unit "g". This is the one container size allowed to be converted without a printed weight.
- Split combined deals: if one price covers multiple distinct products ("pork loin or chicken thighs $3.99/lb"), output one element per product, same price.
- Meat/fish/poultry items — including processed ones (breaded fish, nuggets, sausages, deli): category "meat" and infer the variant from the text/photo: skin (skin-on true / skinless false), bones (bone-in true / boneless false), frozen (true/false). Use your best judgment from wording like "skinless", "boneless", "frozen", "fresh", "back attached"; if truly undeterminable use false for frozen and your best visual guess for skin/bones. Non-meat items: frozen/bones/skin all null.
- Skip anything that is not a grocery product you'd buy to eat or use in the kitchen/home: store banners, event ads, store hours, loyalty-points promos with no concrete product price, toys, clothing, electronics, kitchenware, pet food, garden. If the page turns out to be a pure advertisement with no priced groceries, return an empty array [].
- If a price is unreadable, skip that product.${existingNames.length ? `
- The db already has these items — if a flyer product is the same product as one of these, use that EXACT name (so its price history continues) instead of inventing a new variation: ${JSON.stringify(existingNames)}` : ''}${ignoredNames.length ? `
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

function extractProducts(imgPath, storeName, existingNames, ignoredNames, whitelist) {
  const claude = findClaude()
  log(`${storeName}: extracting with ${claude}`)
  const out = execFileSync(claude, ['-p', EXTRACT_PROMPT(imgPath, existingNames, ignoredNames, whitelist), '--allowedTools', 'Read', '--model', 'claude-sonnet-5'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  })
  const products = lastJsonArray(out)
  const allUnits = Object.values(UNITS).flat()
  return products.filter((p) => p && p.name && p.price > 0 && p.qty > 0 && allUnits.includes(p.unit))
}

// ---------- firestore insert ----------

function kindOf(unit) {
  return Object.keys(UNITS).find((k) => UNITS[k].includes(unit))
}

async function insertProducts(products, storeName, env, validUntil) {
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
    // Meat sold by the piece ("3 pieces $8") is stored as `un` on a weight item:
    // history-only, never compared. Any other kind mismatch is an extraction error.
    const byPiece = isMeat && item.kind === 'weight' && kindOf(p.unit) === 'count'
    if (kindOf(p.unit) !== item.kind && !byPiece) {
      log(`  skip "${p.name}": unit ${p.unit} incompatible with item kind ${item.kind}`)
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
      source: 'flyer',
      validUntil: validUntil ?? null,
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

const workDir = mkdtempSync(join(tmpdir(), 'spmkt-flyers-'))
let failed = false
const results = [] // { name, added? , skipped?, error? }
for (const store of stores) {
  const imgs = []
  try {
    let existingNames = []
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
      ignoredNames = db?.ignored?.map((g) => g.name) ?? []
      // Import whitelist (Settings): only active when toggled on AND non-empty
      // — never lets an empty list silently import nothing. Meat is exempt.
      if (db?.whitelistOn && db?.whitelist?.length) whitelist = db.whitelist.map((r) => r.text)
    }
    const dl = await downloadPages(store, workDir)
    imgs.push(...dl.files)
    // One Claude call per page; a single bad page doesn't sink the store's
    // whole flyer. Cross-page duplicates are handled by insertProducts'
    // one-flyer-record-per-item+store-per-week dedupe.
    const products = []
    let extractFailed = 0
    for (const [i, file] of dl.files.entries()) {
      try {
        const page = extractProducts(file, `${store.name} p${i + 1}/${dl.files.length}`, existingNames, ignoredNames, whitelist)
        products.push(...page)
      } catch (err) {
        extractFailed++
        log(`${store.name}: page ${i + 1} extraction failed (${err.message}) — skipping that page`)
      }
    }
    if (extractFailed === dl.files.length) throw new Error(`extraction failed on all ${dl.files.length} pages`)
    log(`${store.name}: extracted ${products.length} products from ${dl.files.length - extractFailed}/${dl.files.length} pages`)
    if (DRY_RUN) {
      console.log(JSON.stringify(products, null, 2))
    } else {
      const added = await insertProducts(products, store.name, env, dl.validUntil)
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
}

// Notify every registered device with a summary of this run.
if (!DRY_RUN) {
  try {
    const imported = results.filter((r) => r.added != null)
    const errored = results.filter((r) => r.error)
    const skipped = results.filter((r) => r.skipped)
    const totalAdded = imported.reduce((s, r) => s + r.added, 0)
    const title = failed ? '⚠️ Flyer sync finished with errors' : '✅ Flyer sync done'
    const parts = [`${totalAdded} new deal${totalAdded === 1 ? '' : 's'} from ${imported.length} store${imported.length === 1 ? '' : 's'}.`]
    if (errored.length) parts.push(`Failed: ${errored.map((r) => r.name).join(', ')}.`)
    if (classifyFailed) parts.push('Meat classification failed.')
    if (skipped.length) parts.push(`${skipped.length} already up to date.`)
    await sendPush(env, { title, body: parts.join(' ') })
  } catch (err) {
    console.error(`[push] FAILED: ${err.message}`)
  }
}
process.exit(failed ? 1 : 0)
