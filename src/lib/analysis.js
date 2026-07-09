import { normalizedPrice, defaultAnnual, unitKind } from './units'

// Supermarkets increasingly price meat by piece ("3 pieces $8") with no weight
// printed. Such a record is stored honestly as `un` even on a weight item —
// its price can't be normalized against $/100g, so it is REFERENCE-ONLY:
// kept in history, excluded from every comparison. `item` may be omitted by
// callers that already work within one item+kind.
export function isComparable(item, rec) {
  return !item || unitKind(rec.unit) === item.kind
}

export function recordNorm(rec, item) {
  if (!isComparable(item, rec)) return null
  return normalizedPrice(rec.price, rec.qty, rec.unit)
}

export function itemRecords(db, itemId) {
  return db.records
    .filter((r) => r.itemId === itemId)
    .sort((a, b) => b.ts - a.ts)
}

// Meat variations (skin × bones × fresh/frozen) are different products
// per 100 g, so history and comparisons are kept per variant.
export function variantKey(rec) {
  if (rec.bones == null && rec.skin == null && rec.frozen == null) return ''
  return `${rec.bones ? 'b' : '-'}${rec.skin ? 's' : '-'}${rec.frozen ? 'f' : '-'}`
}

export function variantLabel(rec) {
  if (rec.bones == null && rec.skin == null && rec.frozen == null) return ''
  return [
    rec.skin ? 'skin-on' : 'skinless',
    rec.bones ? 'bone-in' : 'boneless',
    rec.frozen ? 'frozen' : 'fresh',
  ].join(', ')
}

// Flyer-imported records carry a validity window. Returns null for normal
// records; otherwise { text, valid } for a badge next to the product name —
// expired flyer prices stay in the db as reference.
export function flyerInfo(rec) {
  if (rec?.source !== 'flyer') return null
  if (!rec.validUntil) return { text: '📰 flyer', valid: true }
  const d = new Date(rec.validUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const valid = Date.now() <= rec.validUntil
  return { text: valid ? `📰 flyer until ${d}` : `📰 flyer ended ${d}`, valid }
}

export function variantRecords(db, itemId, key) {
  return itemRecords(db, itemId).filter((r) => variantKey(r) === key)
}

// Verdict for a record vs the item's history of the SAME variant.
// Returns { level: 'first'|'best'|'good'|'ok'|'high', ... }
export function verdict(db, rec) {
  const item = db.items.find((i) => i.id === rec.itemId)
  const norm = recordNorm(rec, item)
  if (norm == null) return null // by-piece price: nothing to compare it against
  const others = variantRecords(db, rec.itemId, variantKey(rec))
    .filter((r) => r.id !== rec.id && isComparable(item, r))
  if (others.length === 0) return { level: 'first', norm }

  const norms = others.map((r) => recordNorm(r, item)).filter((n) => n != null)
  const best = Math.min(...norms)
  const sorted = [...norms].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  const bestRec = others.find((r) => recordNorm(r, item) === best)
  const bestStore = db.stores.find((s) => s.id === bestRec?.storeId)

  let level
  if (norm <= best * 1.02) level = 'best'
  else if (norm <= best * 1.1) level = 'good'
  else if (norm <= median) level = 'ok'
  else level = 'high'

  return { level, norm, best, bestRec, bestStore, median }
}

// Cheapest latest price per store for an item (optionally a single variant).
export function pricesByStore(db, itemId, variant) {
  const item = db.items.find((i) => i.id === itemId)
  const all = variant == null ? itemRecords(db, itemId) : variantRecords(db, itemId, variant)
  const recs = all.filter((r) => isComparable(item, r)) // by-piece prices can't be ranked
  const byStore = new Map()
  for (const r of recs) {
    if (!byStore.has(r.storeId)) byStore.set(r.storeId, r) // recs sorted desc -> latest wins
  }
  return [...byStore.entries()]
    .map(([storeId, rec]) => ({
      store: db.stores.find((s) => s.id === storeId),
      rec,
      norm: recordNorm(rec, item),
    }))
    .filter((e) => e.store && e.norm != null)
    .sort((a, b) => a.norm - b.norm)
}

export function itemAnnualQty(item) {
  return item.annualQty ?? defaultAnnual(item.category, item.kind)
}

// Yearly savings buying at `bestNorm` instead of `norm` (both per 100 base units, or per unit for count)
export function yearlySavings(item, norm, bestNorm) {
  if (norm == null || bestNorm == null || norm <= bestNorm) return 0
  const annual = itemAnnualQty(item)
  const per = item.kind === 'count' ? 1 : 100
  return ((norm - bestNorm) * annual) / per
}

// Default unit when adding a price: last unit used for item at this store,
// then last unit for the item anywhere, then item default, then store default.
export function suggestedUnit(db, item, storeId) {
  const recs = itemRecords(db, item.id)
  const atStore = recs.find((r) => r.storeId === storeId)
  if (atStore) return atStore.unit
  if (recs[0]) return recs[0].unit
  return item.defaultUnit
}

export function suggestedQty(db, item, storeId) {
  const recs = itemRecords(db, item.id)
  const atStore = recs.find((r) => r.storeId === storeId)
  return atStore?.qty ?? recs[0]?.qty ?? 1
}
