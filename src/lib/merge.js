// Merging duplicate products (e.g. "chicken breast" and "Chicken Breasts").
// Items can only merge with items of the same `kind`; records move over to the
// survivor and the other items are deleted.

import { UNITS, unitKind } from './units'
import { uid } from './db'

// When merged records use mixed units of one kind, they are all rewritten to a
// single unit: the first of these that is actually present among the records.
const UNIT_PREFERENCE = { weight: ['lb', 'kg', 'g', 'oz'], volume: ['L', 'ml'], count: ['un'] }

export function canMerge(items) {
  return items.length >= 2 && items.every((i) => i.kind === items[0].kind)
}

// ---------- merge suggestions (no AI, §15d) ----------
// Words that carry no product identity — packaging, sizes, marketing. They are
// dropped before comparing names so "milk 3.25 bag" and "milk 3.25 Brand X"
// still meet on {milk, 3.25}.
const STOP_WORDS = new Set([
  'the', 'a', 'of', 'and', 'with', 'in', 'de', 'du', 'la', 'le', 'les',
  'bag', 'box', 'pack', 'package', 'carton', 'bottle', 'jar', 'can', 'tin',
  'tray', 'tub', 'pouch', 'jug', 'container', 'sleeve', 'family', 'value',
  'size', 'large', 'small', 'medium', 'mini', 'jumbo', 'big', 'xl',
  'fresh', 'frozen', 'organic', 'natural', 'new', 'select', 'premium',
  'brand', 'style', 'type', 'assorted', 'variety', 'original', 'classic',
  'kg', 'g', 'lb', 'lbs', 'oz', 'ml', 'l', 'un', 'ea', 'each', 'pc', 'pcs',
])

// Name → comparable tokens: lowercased, punctuation stripped, stop words and
// 1-char fragments dropped, crude plural 's' removed so "burger"/"burgers" and
// "breast"/"breasts" are the same token.
export function tokens(name) {
  return [
    ...new Set(
      (name ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}.]+/gu, ' ')
        .split(' ')
        .map((w) => w.replace(/^\.+|\.+$/g, ''))
        // Single letters are noise, but a single digit is a variant ("milk 1%").
        .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP_WORDS.has(w))
        .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
    ),
  ]
}

// How alike two names are, 0…1. Overlap coefficient (shared tokens over the
// *smaller* token set) rather than Jaccard: a short generic name ("beef
// burger") should still score high against a long store name ("beef burgers
// angus quarter pound 4 pack"), which is exactly the merge we want to suggest.
export function nameScore(a, b) {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.length || !tb.length) return 0
  const shared = ta.filter((t) => tb.includes(t)).length
  if (!shared) return 0
  const score = shared / Math.min(ta.length, tb.length)
  // Numbers in a grocery name are almost always the variant that matters
  // ("milk 3.25" vs "milk 1%"). If both names carry numbers and none is
  // shared, they're different products however well the words line up.
  const na = ta.filter((t) => /\d/.test(t))
  const nb = tb.filter((t) => /\d/.test(t))
  if (na.length && nb.length && !na.some((n) => nb.includes(n))) return score * 0.4
  return score
}

// Below this two names are treated as different products.
const SUGGEST_MIN = 0.5

// Items that look like the same product as `item` — same `kind` (merge
// requires it), sorted best match first. `exclude` skips ids already handled.
export function mergeSuggestions(db, item, { exclude = [], limit = 6 } = {}) {
  if (!item) return []
  const skip = new Set([item.id, ...exclude])
  return db.items
    .filter((i) => !skip.has(i.id) && i.kind === item.kind)
    .map((i) => ({ item: i, score: nameScore(item.name, i.name) }))
    .filter((s) => s.score >= SUGGEST_MIN)
    .sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length)
    .slice(0, limit)
}

// The names a (possibly already-merged) item is known by on the shelf: its own
// name plus every distinct `origName` its records carry. Shown when the user
// expands a suggestion — a generic "beef burger" has to reveal the real
// product names behind it for the merge decision to be an informed one.
export function memberNames(db, item) {
  const names = new Set([item.name])
  for (const r of db.records) if (r.itemId === item.id && r.origName) names.add(r.origName)
  return [...names]
}

// Suggested final name: the name of the item with the most records (the most
// established one), ties broken by the shorter name. An item that is already a
// merge group (it has records logged under other names) wins outright — when
// you merge a new product into an existing group, the group name is the
// default, not the newcomer's.
export function suggestName(items, recordCounts, groups = new Set()) {
  return [...items].sort(
    (a, b) =>
      (groups.has(b.id) ? 1 : 0) - (groups.has(a.id) ? 1 : 0) ||
      (recordCounts[b.id] ?? 0) - (recordCounts[a.id] ?? 0) ||
      a.name.length - b.name.length,
  )[0].name
}

// Ids of items that are already merge groups (some record was logged under a
// different name). Used by suggestName to keep the group's name.
export function groupIds(db) {
  return new Set(db.records.filter((r) => r.origName).map((r) => r.itemId))
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

// Searchable text per item: its own name plus every shelf name (`origName`)
// folded into it. Lets a search for "PC" find the group "meatballs" because
// one of its records was logged as "PC meatballs". Lowercased, built once per
// db so a search doesn't rescan every record per item.
export function searchIndex(db) {
  const index = new Map()
  for (const i of db.items) index.set(i.id, i.name.toLowerCase())
  for (const r of db.records) {
    if (!r.origName) continue
    const cur = index.get(r.itemId)
    if (cur == null) continue
    const name = r.origName.toLowerCase()
    if (!cur.includes(name)) index.set(r.itemId, cur + ' | ' + name)
  }
  return index
}

// The item a shelf name belongs to: an item with that exact name, or the merge
// group that already carries it as a member (`origName`). The second case is
// what keeps a re-photographed "PC meatballs" inside the "meatballs" group
// instead of splitting back out as its own product.
export function findByName(items, records, name) {
  const n = (name ?? '').trim().toLowerCase()
  if (!n) return null
  const exact = items.find((i) => i.name.toLowerCase() === n)
  if (exact) return exact
  const member = records.find((r) => (r.origName ?? '').toLowerCase() === n)
  return (member && items.find((i) => i.id === member.itemId)) ?? null
}

// The distinct shelf names folded into a merge group: every `origName` its
// records carry (the group's own name is not an origName). Each is a candidate
// to split back out with `unmergeName`. Returns [{ origName, count }], most
// records first.
export function mergedMembers(db, itemId) {
  const counts = new Map()
  for (const r of db.records) {
    if (r.itemId !== itemId || !r.origName) continue
    counts.set(r.origName, (counts.get(r.origName) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([origName, count]) => ({ origName, count }))
    .sort((a, b) => b.count - a.count || a.origName.localeCompare(b.origName))
}

// Mutates `db`: split every record of `group` logged under `origName` back into
// its own standalone item named `origName`, clearing the `origName` tag. No
// price is lost; the new item inherits the group's kind/defaultUnit/category.
// The reverse of merging one product into a group.
export function unmergeName(db, itemId, origName) {
  const group = db.items.find((i) => i.id === itemId)
  if (!group) return
  const moving = db.records.filter((r) => r.itemId === itemId && r.origName === origName)
  if (!moving.length) return
  const newItem = { ...group, id: uid('i'), name: origName, annualQty: null }
  db.items.push(newItem)
  for (const r of moving) {
    r.itemId = newItem.id
    delete r.origName
  }
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
