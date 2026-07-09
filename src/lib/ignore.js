// "Delete & ignore": products the user doesn't care about (bathroom tissue,
// flour...). The item and its prices are removed, and the name is remembered in
// `db.ignored` so the weekly flyer import never brings it back.
//
// The stored name is the *example*, not a pattern: the flyer import passes the
// list to Claude, which skips any product of the same generic type regardless
// of brand or wording — ignoring "Robin Hood All Purpose Flour" ignores every
// flour, but not other Robin Hood products. `scripts/flyers/run.mjs` also drops
// exact name matches as a cheap backstop.

import { uid } from './db'

export function isIgnored(db, name) {
  const n = name.trim().toLowerCase()
  return (db.ignored ?? []).some((g) => g.name.trim().toLowerCase() === n)
}

// Mutates `db`: deletes the items and every price of theirs, and remembers
// their names.
export function ignoreItems(db, itemIds) {
  for (const id of itemIds) {
    const item = db.items.find((i) => i.id === id)
    if (item && !isIgnored(db, item.name)) {
      db.ignored ??= []
      db.ignored.push({ id: uid('g'), name: item.name.trim(), ts: Date.now() })
    }
  }
  db.items = db.items.filter((i) => !itemIds.includes(i.id))
  db.records = db.records.filter((r) => !itemIds.includes(r.itemId))
}

export function unignore(db, ignoredId) {
  db.ignored = (db.ignored ?? []).filter((g) => g.id !== ignoredId)
}
