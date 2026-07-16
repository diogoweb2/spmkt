// Import whitelist: keyword rules the weekly flyer import hands to the LLM so
// that ONLY matching NON-MEAT products get imported ("Yogurt but only Greek
// style", "Chips but not Pringles", "all fruits but not organic"). Rules are
// plain language and may carry exceptions — the LLM interprets them, they are
// not string matches. Meat is exempt (always imported); unwanted meat is
// handled by delete & ignore. The ignored list (ignore.js) always wins over a
// whitelist match. Toggling off resumes importing everything; already-imported
// items stay until removed manually.

import { uid } from './db'

export function whitelistRules(db) {
  return db.whitelist ?? []
}

// The whitelist only restricts the import when it's on AND has rules —
// an empty list with the toggle on imports everything (never silently
// imports nothing).
export function whitelistActive(db) {
  return !!db.whitelistOn && whitelistRules(db).length > 0
}

export function addWhitelistRule(db, text) {
  const t = text.trim()
  if (!t) return
  db.whitelist ??= []
  if (db.whitelist.some((r) => r.text.trim().toLowerCase() === t.toLowerCase())) return
  db.whitelist.push({ id: uid('w'), text: t, ts: Date.now() })
}

export function removeWhitelistRule(db, id) {
  db.whitelist = (db.whitelist ?? []).filter((r) => r.id !== id)
}
