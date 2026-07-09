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

async function downloadFirstPage(store, dir) {
  const res = await fetch(store.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`fetch ${store.url}: HTTP ${res.status}`)
  const html = await res.text()
  // Full-res page images look like /data/promotions/<id>/<slug>_01.jpg — take
  // the first promotion on the page (the main weekly flyer).
  const m = html.match(/https:\/\/www\.flyers-on-line\.com\/data\/promotions\/\d+\/[^"' ]+_01\.jpg[^"' ]*/)
  if (!m) throw new Error(`no flyer page-1 image found at ${store.url}`)
  const imgRes = await fetch(m[0], { headers: { 'User-Agent': 'Mozilla/5.0', Referer: store.url } })
  if (!imgRes.ok) throw new Error(`image download: HTTP ${imgRes.status}`)
  const file = join(dir, `${store.name.toLowerCase().replace(/\W+/g, '-')}-page1.jpg`)
  writeFileSync(file, Buffer.from(await imgRes.arrayBuffer()))
  log(`${store.name}: downloaded ${m[0]} -> ${file}`)
  return file
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

const EXTRACT_PROMPT = (imgPath) => `Read the flyer image at ${imgPath} and extract every grocery deal on it.

Output ONLY a JSON array (no prose, no markdown fence). Each element:
{"name": string, "category": "meat"|"other", "price": number, "qty": number, "unit": "kg"|"g"|"lb"|"oz"|"L"|"ml"|"un", "frozen": boolean|null, "bones": boolean|null, "skin": boolean|null}

Rules:
- name: clean generic product name with brand if shown (e.g. "Chicken Drumsticks", "Coca-Cola 12-pack"). No sizes/prices in the name.
- price is in dollars for the stated qty+unit. "$2.99/lb" -> price 2.99, qty 1, unit "lb". "2 for $5" -> price 2.50, qty 1, unit "un". A 1.89 L juice at $3.99 -> price 3.99, qty 1.89, unit "L". If sold by weight/volume use that unit; packaged goods with no usable size -> unit "un", qty 1.
- Split combined deals: if one price covers multiple distinct products ("pork loin or chicken thighs $3.99/lb"), output one element per product, same price.
- Meat items: category "meat" and infer the variant from the text/photo: skin (skin-on true / skinless false), bones (bone-in true / boneless false), frozen (true/false). Use your best judgment from wording like "skinless", "boneless", "frozen", "fresh", "back attached"; if truly undeterminable use false for frozen and your best visual guess for skin/bones. Non-meat items: frozen/bones/skin all null.
- Skip non-product content (banners, store hours, points promos without a concrete product price).
- If a price is unreadable, skip that product.`

function extractProducts(imgPath, storeName) {
  const claude = findClaude()
  log(`${storeName}: extracting with ${claude}`)
  const out = execFileSync(claude, ['-p', EXTRACT_PROMPT(imgPath), '--allowedTools', 'Read'], {
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

async function insertProducts(products, storeName, env) {
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
  if (!snap.exists()) throw new Error('family db doc not found')
  const db = snap.data()
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
    }
    // Dedupe: identical flyer deal already captured this week.
    const dup = db.records.some((r) =>
      r.itemId === rec.itemId && r.storeId === rec.storeId && r.price === rec.price &&
      r.qty === rec.qty && r.unit === rec.unit && r.frozen === rec.frozen &&
      r.bones === rec.bones && r.skin === rec.skin && r.ts > weekAgo)
    if (dup) continue
    db.records.push(rec)
    added++
  }
  await setDoc(ref, db)
  log(`${storeName}: saved ${added} new records (${products.length - added} skipped as dupes/invalid)`)
}

// ---------- main ----------

const stores = JSON.parse(readFileSync(join(here, 'stores.json'), 'utf8'))
const env = loadEnv()
if (!DRY_RUN && !env.FAMILY_PASSWORD) {
  console.error('FAMILY_PASSWORD missing in scripts/flyers/.env — add it, or run with --dry-run')
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'spmkt-flyers-'))
let failed = false
for (const store of stores) {
  let img
  try {
    img = await downloadFirstPage(store, workDir)
    const products = extractProducts(img, store.name)
    log(`${store.name}: extracted ${products.length} products`)
    if (DRY_RUN) {
      console.log(JSON.stringify(products, null, 2))
    } else {
      await insertProducts(products, store.name, env)
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
