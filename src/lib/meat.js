// Meat deals: grouping by animal, natural vs ultra-processed, and market-based
// deal ratings. Items get `meatType`, `processing` and `market` from the weekly
// LLM classification pass (scripts/flyers/classify-meat.mjs); manual items
// default to processing 'natural' and are classified on the next pass.

import { UNITS, unitKind, normalizedPrice } from './units'
import { itemRecords, isComparable, recordNorm } from './analysis'
import { effectivePrice } from './cashback'

export const MEAT_TYPES = ['beef', 'pork', 'chicken', 'fish', 'other']

export const MEAT_TYPE_LABEL = {
  beef: '🐄 Beef',
  pork: '🐖 Pork',
  chicken: '🐔 Chicken',
  fish: '🐟 Fish',
  other: '🍖 Other meat',
}

export const PROCESSING_LABEL = { natural: 'Natural', ultra: 'Ultra-processed' }

// Supermarket sections for non-meat items (`groceryType`, labeled by
// scripts/flyers/classify-grocery.mjs — keep the lists in sync). Unlabeled
// items file under "other" until the pass runs.
export const GROCERY_TYPES = ['produce', 'dairy', 'bakery', 'frozen', 'pantry', 'snacks', 'beverages', 'household', 'other']

export const GROCERY_TYPE_LABEL = {
  produce: '🥬 Produce',
  dairy: '🥛 Dairy & Eggs',
  bakery: '🍞 Bakery',
  frozen: '🧊 Frozen',
  pantry: '🥫 Pantry',
  snacks: '🍿 Snacks',
  beverages: '🥤 Beverages',
  household: '🧻 Household',
  other: '🛒 Other',
}

// Instant keyword-based meat-type guess for items the weekly LLM pass hasn't
// classified yet (manual items land on Home right away instead of under
// "Other meat"). The LLM pass later writes the authoritative `meatType`.
const TYPE_WORDS = {
  beef: /\b(beef|steak|veal|angus|brisket|sirloin|ribeye|striploin|t-bone)\b/,
  pork: /\b(pork|ham|bacon|prosciutto|pancetta|capicollo)\b/,
  chicken: /\b(chicken|poulet|hen)\b/,
  fish: /\b(fish|salmon|tilapia|basa|trout|cod|haddock|tuna|sardines?|mackerel|halibut|shrimp|seafood|crab|lobster|scallops?)\b/,
}

export function guessMeatType(name) {
  const n = (name ?? '').toLowerCase()
  for (const [type, re] of Object.entries(TYPE_WORDS)) if (re.test(n)) return type
  return null
}

export const RATING = {
  excellent: { label: '🔥 Excellent deal', cls: 'lvl-best' },
  good: { label: '👍 Good deal', cls: 'lvl-good' },
  average: { label: '😐 Average', cls: 'lvl-ok' },
  bad: { label: '❌ Bad deal', cls: 'lvl-high' },
}

// Rates a normalized price (per 100 g) against the item's LLM-researched
// Toronto market thresholds ($/lb). null when the item has no market data yet.
export function dealRating(item, norm) {
  const m = item.market
  if (!m || norm == null) return null
  const perLb = norm * (UNITS.lb.toBase / 100)
  if (perLb <= m.excellent) return 'excellent'
  if (perLb <= m.good) return 'good'
  if (perLb <= m.avg) return 'average'
  return 'bad'
}

// An item's current deals: each store's latest non-expired record; the
// cheapest store wins. Records with no validUntil (manual entries) never
// expire. Returns up to TWO deals per item:
// - a comparable deal (normalized $/100g etc), and
// - a by-piece deal (§3 reference `un` records on a weight/volume item,
//   normalized per unit) — surfaced on Home so the user notices it and can
//   edit in the real weight; it never mixes into comparison math.
function bestDeals(db, item, now) {
  const recs = itemRecords(db, item.id).filter(
    (r) => r.validUntil == null || r.validUntil >= now,
  )
  const pick = (list, normOf) => {
    const byStore = new Map()
    for (const r of list) {
      if (!byStore.has(r.storeId)) byStore.set(r.storeId, r) // recs sorted desc -> latest wins
    }
    let best = null
    for (const rec of byStore.values()) {
      const norm = normOf(rec)
      if (norm != null && (!best || norm < best.norm)) best = { rec, norm }
    }
    if (!best) return null
    const store = db.stores.find((s) => s.id === best.rec.storeId)
    if (!store) return null
    return { item, store, rec: best.rec, norm: best.norm }
  }
  const deal = pick(recs.filter((r) => isComparable(item, r)), (r) => recordNorm(r, item, db))
  const piece = item.kind === 'count' ? null : pick(
    recs.filter((r) => unitKind(r.unit) === 'count'),
    (r) => normalizedPrice(effectivePrice(db, r), r.qty, r.unit),
  )
  const out = []
  if (deal) out.push({ ...deal, key: item.id, byPiece: false })
  if (piece) out.push({ ...piece, key: `${item.id}|bp`, byPiece: true })
  return out
}

// Current best deal(s) per meat item, grouped by meat type.
export function meatDeals(db) {
  const now = Date.now()
  const groups = {}
  for (const item of db.items) {
    if (item.category !== 'meat') continue
    for (const best of bestDeals(db, item, now)) {
      const type = MEAT_TYPES.includes(item.meatType)
        ? item.meatType
        : guessMeatType(item.name) ?? 'other'
      ;(groups[type] ??= []).push({
        ...best,
        // by-piece prices can't be rated against $/lb market thresholds
        rating: best.byPiece ? null : dealRating(item, best.norm),
        ultra: item.processing === 'ultra',
      })
    }
  }
  // Natural products first, then ultra-processed; cheapest first within each.
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (a.ultra === b.ultra ? a.norm - b.norm : a.ultra ? 1 : -1))
  }
  return groups
}

// Current best deal per non-meat item, cheapest first — Home's 🛒 Groceries
// view. Non-meat items have no market data (rating stays null) but carry a
// `groceryType` supermarket section (classify-grocery.mjs) used as a filter;
// unlabeled items count as "other".
export function groceryDeals(db) {
  const now = Date.now()
  const out = []
  for (const item of db.items) {
    if (item.category === 'meat') continue
    const gtype = GROCERY_TYPES.includes(item.groceryType) ? item.groceryType : 'other'
    for (const best of bestDeals(db, item, now)) {
      out.push({ ...best, gtype, rating: best.byPiece ? null : dealRating(item, best.norm), ultra: false })
    }
  }
  out.sort((a, b) => a.norm - b.norm)
  return out
}
