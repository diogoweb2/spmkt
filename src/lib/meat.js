// Meat deals: grouping by animal, natural vs ultra-processed, and market-based
// deal ratings. Items get `meatType`, `processing` and `market` from the weekly
// LLM classification pass (scripts/flyers/classify-meat.mjs); manual items
// default to processing 'natural' and are classified on the next pass.

import { UNITS } from './units'
import { itemRecords, isComparable, recordNorm } from './analysis'

export const MEAT_TYPES = ['beef', 'pork', 'chicken', 'fish', 'other']

export const MEAT_TYPE_LABEL = {
  beef: '🐄 Beef',
  pork: '🐖 Pork',
  chicken: '🐔 Chicken',
  fish: '🐟 Fish',
  other: '🍖 Other meat',
}

export const PROCESSING_LABEL = { natural: 'Natural', ultra: 'Ultra-processed' }

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

// Current best deal per meat item, grouped by meat type. A deal is each
// store's latest non-expired comparable record; the cheapest store wins.
// Records with no validUntil (manual entries) never expire.
export function meatDeals(db) {
  const now = Date.now()
  const groups = {}
  for (const item of db.items) {
    if (item.category !== 'meat') continue
    const recs = itemRecords(db, item.id).filter(
      (r) => isComparable(item, r) && (r.validUntil == null || r.validUntil >= now),
    )
    const byStore = new Map()
    for (const r of recs) {
      if (!byStore.has(r.storeId)) byStore.set(r.storeId, r) // recs sorted desc -> latest wins
    }
    let best = null
    for (const rec of byStore.values()) {
      const norm = recordNorm(rec, item, db)
      if (norm != null && (!best || norm < best.norm)) best = { rec, norm }
    }
    if (!best) continue
    const store = db.stores.find((s) => s.id === best.rec.storeId)
    if (!store) continue
    const rating = dealRating(item, best.norm)
    const type = MEAT_TYPES.includes(item.meatType)
      ? item.meatType
      : guessMeatType(item.name) ?? 'other'
    ;(groups[type] ??= []).push({
      item,
      store,
      rec: best.rec,
      norm: best.norm,
      rating,
      ultra: item.processing === 'ultra',
    })
  }
  // Natural products first, then ultra-processed; cheapest first within each.
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (a.ultra === b.ultra ? a.norm - b.norm : a.ultra ? 1 : -1))
  }
  return groups
}
