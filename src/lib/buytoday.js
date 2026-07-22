import { itemRecords, recordNorm, isComparable, variantKey, variantLabel } from './analysis'

// "Buy it today!" — surfaced Wednesdays after the upcoming-flyer import (§12).
// It answers "should I buy on this week's deal or wait for next week's?" for
// products that have BOTH a live deal now and one in the just-imported upcoming
// flyer, whenever THIS week's price is the better of the two.
//
// Classifying a flyer record as current vs upcoming can't rely on the
// `upcoming` flag alone: last week's upcoming import is this week's LIVE deal
// yet still carries `upcoming: true`. So a record counts as upcoming only when
// it was imported in this week's fresh batch (flagged upcoming AND imported in
// the last few days); every other still-valid flyer price is treated as current.
const RECENT_MS = 3 * 24 * 3600 * 1000

// Entries where today's best price beats next week's, biggest saving first.
// Each: { item, variant, variantLabel, current, upcoming, pct } where current
// and upcoming are { rec, store, norm } for the same product variant.
export function buyTodayDeals(db, now = Date.now()) {
  const out = []
  for (const item of db.items) {
    // Flyer prices still valid today that can actually be ranked ($/unit).
    const recs = itemRecords(db, item.id).filter(
      (r) =>
        r.source === 'flyer' &&
        isComparable(item, r) &&
        recordNorm(r, item, db) != null &&
        (r.validUntil == null || r.validUntil >= now),
    )
    if (recs.length < 2) continue

    // Compare like with like: meat variants (skin/bones/fresh) are separate.
    const byVariant = new Map()
    for (const r of recs) {
      const k = variantKey(r)
      if (!byVariant.has(k)) byVariant.set(k, [])
      byVariant.get(k).push(r)
    }

    const isUpcoming = (r) => !!r.upcoming && r.ts >= now - RECENT_MS
    const bestOf = (list) =>
      list
        .map((rec) => ({ rec, store: db.stores.find((s) => s.id === rec.storeId), norm: recordNorm(rec, item, db) }))
        .filter((e) => e.store && e.norm != null)
        .sort((a, b) => a.norm - b.norm)[0]

    for (const vrecs of byVariant.values()) {
      const upc = vrecs.filter(isUpcoming)
      const cur = vrecs.filter((r) => !isUpcoming(r))
      if (!upc.length || !cur.length) continue
      const current = bestOf(cur)
      const upcoming = bestOf(upc)
      if (!current || !upcoming || current.norm >= upcoming.norm) continue
      const pct = Math.round(((upcoming.norm - current.norm) / upcoming.norm) * 100)
      if (pct < 1) continue // negligible difference — not worth flagging
      out.push({ item, variant: variantKey(vrecs[0]), variantLabel: variantLabel(vrecs[0]), current, upcoming, pct })
    }
  }
  return out.sort((a, b) => b.pct - a.pct)
}
