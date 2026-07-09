// Weekly flyer import: downloads page 1 of each store's flyer from
// flyers-on-line.com, has Claude (headless) read the image and extract the
// deals, then appends them as price records to the shared family db in
// Firestore. The image is deleted after processing.
//
// Usage:
//   node scripts/flyers/run.mjs            # full run (needs .env with password)
//   node scripts/flyers/run.mjs --dry-run  # extract only, print what would be saved
//
// Config: scripts/flyers/stores.json (one entry per supermarket).
// Secrets: scripts/flyers/.env with FAMILY_PASSWORD=<app password> (gitignored).

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
const UNITS = { weight: ['kg', 'g', 'lb', 'oz'], volume: ['L', 'ml'], count: ['un'] }

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

// ---------- config / secrets ----------

function loadEnv() {
  const envPath = join(here, '.env')
  if (!existsSync(envPath)) return {}
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  )
}

// ---------- download ----------

// "Valid from July 9 to 15, 2026" / "Valid from June 30 to July 6, 2026" ->
// timestamp of the last valid day, end of day. null if not found.
function parseValidUntil(html) {
  const m = html.match(/Valid from\s+([A-Za-z]+)\s+\d{1,2}\s+to\s+(?:([A-Za-z]+)\s+)?(\d{1,2}),?\s+(\d{4})/)
  if (!m) return null
  const dt = new Date(`${m[2] || m[1]} ${m[3]}, ${m[4]} 23:59:59`)
  return isNaN(dt) ? null : dt.getTime()
}

async function downloadFirstPage(store, dir) {
  const res = await fetch(store.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`fetch ${store.url}: HTTP ${res.status}`)
  const html = await res.text()
  const validUntil = parseValidUntil(html)
  // Full-res page images look like /data/promotions/<id>/<slug>_01.jpg — take
  // the first promotion on the page (the main weekly flyer).
  const m = html.match(/https:\/\/www\.flyers-on-line\.com\/data\/promotions\/\d+\/[^"' ]+_01\.jpg[^"' ]*/)
  if (!m) throw new Error(`no flyer page-1 image found at ${store.url}`)
  const imgRes = await fetch(m[0], { headers: { 'User-Agent': 'Mozilla/5.0', Referer: store.url } })
  if (!imgRes.ok) throw new Error(`image download: HTTP ${imgRes.status}`)
  const file = join(dir, `${store.name.toLowerCase().replace(/\W+/g, '-')}-page1.jpg`)
  writeFileSync(file, Buffer.from(await imgRes.arrayBuffer()))
  log(`${store.name}: downloaded ${m[0]} -> ${file} (valid until ${validUntil ? new Date(validUntil).toDateString() : 'unknown'})`)
  return { file, validUntil }
}

// ---------- claude extraction ----------

function findClaude() {
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(homedir(), '.local/bin/claude')]) {
    if (existsSync(p)) return p
  }
  // Fall back to the binary bundled with the newest VSCode extension.
  const extDir = join(homedir(), '.vscode/extensions')
  const candidates = readdirSync(extDir)
    .filter((d) => d.startsWith('anthropic.claude-code-'))
    .sort()
  for (const d of candidates.reverse()) {
    const bin = join(extDir, d, 'resources/native-binary/claude')
    if (existsSync(bin)) return bin
  }
  throw new Error('claude CLI not found')
}

const EXTRACT_PROMPT = (imgPath) => `Use the Read tool to open the image file ${imgPath} — it is a supermarket flyer page and you CAN view images via the Read tool. Then extract every grocery deal on it.

Output ONLY a JSON array (no prose, no markdown fence). Each element:
{"name": string, "category": "meat"|"other", "price": number, "qty": number, "unit": "kg"|"g"|"lb"|"oz"|"L"|"ml"|"un", "frozen": boolean|null, "bones": boolean|null, "skin": boolean|null}

Rules:
- name: clean generic product name with brand if shown (e.g. "Chicken Drumsticks", "Coca-Cola 12-pack"). No sizes/prices in the name.
- price is in dollars for the stated qty+unit. "$2.99/lb" -> price 2.99, qty 1, unit "lb". "2 for $5" -> price 2.50, qty 1, unit "un". A 1.89 L juice at $3.99 -> price 3.99, qty 1.89, unit "L". If sold by weight/volume use that unit; packaged goods with no usable size -> unit "un", qty 1.
- Packaged/boxed products (frozen meat boxes, nuggets, wings, breaded fish, burgers, ice cream tubs...): ALWAYS use the printed package size as qty+unit (e.g. 750 g box -> qty 750 unit "g"; 1.1 kg -> qty 1.1 unit "kg") so different box sizes are comparable across stores. Only use unit "un" when no size is printed. If a multi-product deal shows a different size per product, use each product's own size.
- Split combined deals: if one price covers multiple distinct products ("pork loin or chicken thighs $3.99/lb"), output one element per product, same price.
- Meat items: category "meat" and infer the variant from the text/photo: skin (skin-on true / skinless false), bones (bone-in true / boneless false), frozen (true/false). Use your best judgment from wording like "skinless", "boneless", "frozen", "fresh", "back attached"; if truly undeterminable use false for frozen and your best visual guess for skin/bones. Non-meat items: frozen/bones/skin all null.
- Skip non-product content (banners, store hours, points promos without a concrete product price).
- If a price is unreadable, skip that product.`

function extractProducts(imgPath, storeName) {
  const claude = findClaude()
  log(`${storeName}: extracting with ${claude}`)
  const out = execFileSync(claude, ['-p', EXTRACT_PROMPT(imgPath), '--allowedTools', 'Read', '--model', 'claude-sonnet-5'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  })
  const start = out.indexOf('[')
  const end = out.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error(`no JSON array in claude output:\n${out.slice(0, 500)}`)
  const products = JSON.parse(out.slice(start, end + 1))
  const allUnits = Object.values(UNITS).flat()
  return products.filter((p) => p && p.name && p.price > 0 && p.qty > 0 && allUnits.includes(p.unit))
}

// ---------- firestore insert ----------

function kindOf(unit) {
  return Object.keys(UNITS).find((k) => UNITS[k].includes(unit))
}

// Opens the family db doc, preferring the service-account key (writes
// directly, no password) and falling back to family-password sign-in.
async function openFamilyDoc(env) {
  const keyPath = join(here, 'service-account.json')
  if (existsSync(keyPath)) {
    const { initializeApp, cert } = await import('firebase-admin/app')
    const { getAuth } = await import('firebase-admin/auth')
    const { getFirestore } = await import('firebase-admin/firestore')
    const app = initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) })
    const user = await getAuth(app).getUserByEmail('family@smartprice.app')
    const ref = getFirestore(app).doc(`users/${user.uid}`)
    const snap = await ref.get()
    return { db: snap.exists ? snap.data() : null, save: (db) => ref.set(db) }
  }
  if (!env.FAMILY_PASSWORD) throw new Error('need scripts/flyers/service-account.json or FAMILY_PASSWORD in .env')
  const { initializeApp } = await import('firebase/app')
  const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth')
  const { getFirestore, doc, getDoc, setDoc } = await import('firebase/firestore')
  const app = initializeApp({
    apiKey: 'AIzaSyCVCDsMH1-cJ2rr_7o8WVBG26__Jl2bMXg',
    authDomain: 'spmkt-cc6fd.firebaseapp.com',
    projectId: 'spmkt-cc6fd',
  })
  const cred = await signInWithEmailAndPassword(getAuth(app), 'family@smartprice.app', env.FAMILY_PASSWORD)
  const ref = doc(getFirestore(app), 'users', cred.user.uid)
  const snap = await getDoc(ref)
  return { db: snap.exists() ? snap.data() : null, save: (db) => setDoc(ref, db) }
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

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
  let added = 0
  for (const p of products) {
    const isMeat = p.category === 'meat'
    let item = db.items.find((i) => i.name.trim().toLowerCase() === p.name.trim().toLowerCase())
    if (!item) {
      item = { id: uid('i'), name: p.name.trim(), category: isMeat ? 'meat' : 'other', kind: kindOf(p.unit), defaultUnit: p.unit, annualQty: null }
      db.items.push(item)
    }
    if (kindOf(p.unit) !== item.kind) {
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
    // Dedupe: flyers are weekly, so at most one flyer record per
    // item+store+variant per week (extraction can vary slightly run to run).
    const dup = db.records.some((r) =>
      r.source === 'flyer' && r.itemId === rec.itemId && r.storeId === rec.storeId &&
      r.frozen === rec.frozen && r.bones === rec.bones && r.skin === rec.skin && r.ts > weekAgo)
    if (dup) continue
    db.records.push(rec)
    added++
  }
  await save(db)
  log(`${storeName}: saved ${added} new records (${products.length - added} skipped as dupes/invalid)`)
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
for (const store of stores) {
  let img
  try {
    const dl = await downloadFirstPage(store, workDir)
    img = dl.file
    const products = extractProducts(img, store.name)
    log(`${store.name}: extracted ${products.length} products`)
    if (DRY_RUN) {
      console.log(JSON.stringify(products, null, 2))
    } else {
      await insertProducts(products, store.name, env, dl.validUntil)
    }
  } catch (err) {
    failed = true
    console.error(`[${store.name}] FAILED: ${err.message}`)
  } finally {
    if (img && existsSync(img)) unlinkSync(img)
  }
}
rmSync(workDir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
