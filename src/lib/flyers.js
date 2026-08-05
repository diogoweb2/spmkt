// 📄 Flyer browser (BUSINESS_RULES §17): the app fetches a store's flyer page
// straight from flyers-on-line.com and reads the page images out of the HTML.
// flyers-on-line serves both the HTML and the JPEGs with
// `access-control-allow-origin: *`, so no proxy, no server, and no copy in
// Storage is needed — the browser can load the pages directly.
//
// The user draws a box around one deal on a page; Flyers.jsx crops it and
// queues the crop as a photo (src/lib/photos.js), which the existing daily
// vision job turns into a Review card. Manual cropping replaced the automatic
// whole-flyer extraction, which kept skipping the big front-page deals.
//
// Page URLs carry the promotion id of the CURRENT flyer and stop resolving
// once next week's flyer goes up, so a crop must be queued (uploaded) while
// the flyer is live — which is why the crop is uploaded, not the coordinates.

// Store name -> flyer page. Mirrors scripts/flyers/stores.json (the import job
// reads the same list); keep the two in sync when a store is added.
export const FLYER_STORES = [
  { name: 'FreshCo', url: 'https://www.flyers-on-line.com/freshco/ontario' },
  { name: 'No Frills', url: 'https://www.flyers-on-line.com/no-frills/ontario' },
  { name: 'Walmart', url: 'https://www.flyers-on-line.com/walmart/ontario' },
  { name: 'Metro', url: 'https://www.flyers-on-line.com/metro/ontario' },
  { name: 'Food Basics', url: 'https://www.flyers-on-line.com/food-basics' },
  { name: 'Superstore', url: 'https://www.flyers-on-line.com/real-canadian-superstore/ontario' },
]

// Ordered, deduped page-image URLs from a flyer page's HTML. Port of
// flyerImageUrls() in scripts/flyers/shared.mjs — same dedupe on the URL
// without its ?v= cachebuster (each page is linked both bare and versioned,
// and keeping both shifts every page number by one). Page N is urls[N - 1].
export function flyerImageUrls(html) {
  const seen = new Set()
  const urls = []
  for (const m of html.matchAll(/https:\/\/www\.flyers-on-line\.com\/data\/promotions\/\d+\/[^"' ]+_\d{2}\.jpg[^"' ]*/g)) {
    const key = m[0].split('?')[0]
    if (seen.has(key)) continue
    seen.add(key)
    urls.push(m[0])
  }
  return urls
}

// "Valid from July 9 to 15, 2026" / "Valid from June 30 to July 6, 2026" ->
// timestamp of the last valid day, end of day. null if not found. Port of
// parseValidUntil() in scripts/flyers/run.mjs — a crop's record inherits this
// as its validUntil, so a cropped deal expires like an imported one.
export function parseValidUntil(html) {
  const m = html.match(/Valid from\s+([A-Za-z]+)\s+\d{1,2}\s+to\s+(?:([A-Za-z]+)\s+)?(\d{1,2}),?\s+(\d{4})/)
  if (!m) return null
  const dt = new Date(`${m[2] || m[1]} ${m[3]}, ${m[4]} 23:59:59`)
  return isNaN(dt) ? null : dt.getTime()
}

// Load one store's flyer: { url, pages: [imageUrl], validUntil }.
// `upcoming` fetches next week's flyer (…/upcoming-flyer) — the deals can't be
// bought yet, so crops from it are flagged and show the 🔜 badge (§12).
export async function loadFlyer(store, { upcoming = false } = {}) {
  const url = upcoming ? `${store.url}/upcoming-flyer` : store.url
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load the ${store.name} flyer (HTTP ${res.status}).`)
  const html = await res.text()
  const pages = flyerImageUrls(html)
  if (!pages.length) throw new Error(`No flyer pages found for ${store.name}${upcoming ? " — next week's flyer may not be up yet." : '.'}`)
  return { url, pages, validUntil: parseValidUntil(html) }
}

// Crop a normalized box ({x, y, w, h}, each 0-1 of the page) out of a page
// image and return it as a JPEG blob for upload. Drawn on the natural-size
// image, not the on-screen one, so a zoomed-out page still yields a crop at
// full flyer resolution — the vision pass has to read small print (sizes,
// "member price", multi-buy) off it.
export async function cropPage(pageUrl, box) {
  const img = new Image()
  img.crossOrigin = 'anonymous' // flyers-on-line sends ACAO *, so the canvas stays untainted
  img.src = pageUrl
  await img.decode()
  const sx = Math.round(box.x * img.naturalWidth)
  const sy = Math.round(box.y * img.naturalHeight)
  const sw = Math.max(1, Math.round(box.w * img.naturalWidth))
  const sh = Math.max(1, Math.round(box.h * img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9))
  if (!blob) throw new Error('Could not crop that area.')
  return blob
}
