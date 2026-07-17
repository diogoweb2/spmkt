// Merging duplicate products (e.g. "chicken breast" and "Chicken Breasts").
// Items can only merge with items of the same `kind`; records move over to the
// survivor and the other items are deleted.

import { UNITS, unitKind } from './units'

// When merged records use mixed units of one kind, they are all rewritten to a
// single unit: the first of these that is actually present among the records.
const UNIT_PREFERENCE = { weight: ['lb', 'kg', 'g', 'oz'], volume: ['L', 'ml'], count: ['un'] }

export function canMerge(items) {
  return items.length >= 2 && items.every((i) => i.kind === items[0].kind)
}

// Suggested final name: the name of the item with the most records (the most
// established one), ties broken by the shorter name.
export function suggestName(items, recordCounts) {
  return [...items]
    .sort((a, b) => (recordCounts[b.id] ?? 0) - (recordCounts[a.id] ?? 0) || a.name.length - b.name.length)[0]
    .name
}

// The unit all comparable records will end up in, or null if they already
// share one (nothing to rewrite).
export function targetUnit(items, records) {
  const kind = items[0].kind
  const used = new Set(records.filter((r) => unitKind(r.unit) === kind).map((r) => r.unit))
  if (used.size < 2) return null
  return UNIT_PREFERENCE[kind].find((u) => used.has(u)) ?? null
}

function convertQty(qty, from, to) {
  const q = (qty * UNITS[from].toBase) / UNITS[to].toBase
  return Math.round(q * 1000) / 1000
}

// What the merged item's fields will be. Meat wins over other categories (it
// carries the fresh/frozen, bones and skin variants); the largest explicit
// annual quantity wins; `null` means "use the default".
export function mergedItem(items, records, name) {
  const kind = items[0].kind
  const annuals = items.map((i) => i.annualQty).filter((q) => q != null)
  const target = targetUnit(items, records)
  const defaultUnit =
    target ??
    items.find((i) => i.defaultUnit && unitKind(i.defaultUnit) === kind)?.defaultUnit ??
    UNIT_PREFERENCE[kind][0]
  return {
    ...items[0],
    name,
    kind,
    category: items.some((i) => i.category === 'meat')
      ? 'meat'
      : (items.find((i) => i.category && i.category !== 'other')?.category ?? 'other'),
    defaultUnit,
    annualQty: annuals.length ? Math.max(...annuals) : null,
    // Meat classification survives a merge: first item that has each field wins.
    meatType: items.find((i) => i.meatType)?.meatType ?? null,
    processing: items.find((i) => i.processing)?.processing ?? null,
    market: items.find((i) => i.market)?.market ?? null,
  }
}

// Mutates `db`: keeps items[0], moves every record onto it (converting units
// where needed), drops the other items. By-piece records (unit kind ≠ item
// kind) keep their `un` unit — the app never invents a weight.
export function mergeItems(db, itemIds, name) {
  const items = itemIds.map((id) => db.items.find((i) => i.id === id)).filter(Boolean)
  if (!canMerge(items)) return
  const records = db.records.filter((r) => itemIds.includes(r.itemId))
  const survivor = mergedItem(items, records, name)
  const target = targetUnit(items, records)

  for (const r of db.records) {
    if (!itemIds.includes(r.itemId)) continue
    // Keep the name the record was logged under — merges rename items, and the
    // original (store-specific) name is what you look for on the shelf.
    const from = items.find((i) => i.id === r.itemId)
    if (!r.origName && from && from.name !== name) r.origName = from.name
    r.itemId = survivor.id
    if (target && r.unit !== target && unitKind(r.unit) === survivor.kind) {
      r.qty = convertQty(r.qty, r.unit, target)
      r.unit = target
    }
  }
  db.items = db.items
    .filter((i) => i.id === survivor.id || !itemIds.includes(i.id))
    .map((i) => (i.id === survivor.id ? survivor : i))

  dropDuplicateFlyerRecords(db, survivor.id)
}

// Flyer imports dedupe per item+store, so the same real-world flyer deal can
// land on two records if it was matched to different (not-yet-merged) items
// during import. Once merged onto one item, collapse records that share a
// store, flyer window (`validUntil`) and variant, keeping the most recently
// imported one. Manual/photo records are untouched — they're append-only.
function dropDuplicateFlyerRecords(db, survivorId) {
  const groups = new Map()
  for (const r of db.records) {
    if (r.itemId !== survivorId || r.source !== 'flyer') continue
    const key = [r.storeId, r.validUntil ?? '', r.frozen, r.bones, r.skin].join('|')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const toDrop = new Set()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const keep = group.reduce((a, b) => (b.ts > a.ts ? b : a))
    for (const r of group) if (r !== keep) toDrop.add(r.id)
  }
  if (toDrop.size) db.records = db.records.filter((r) => !toDrop.has(r.id))
}
