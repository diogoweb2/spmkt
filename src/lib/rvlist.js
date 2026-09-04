// Bridge to the RV & Groceries app (Firebase project rv-groceries): sends a
// deal to its addFromSmartPrice Cloud Function, which drops the item onto the
// matching store's shopping list with the price and valid-until date attached.
// Auth: our own Firebase ID token (the function verifies it against this
// project's securetoken certs), so no secret lives in this bundle.

import { auth } from './firebase'

const ENDPOINT = 'https://us-central1-rv-groceries.cloudfunctions.net/addFromSmartPrice'

// deal: { storeName, itemName, priceLabel, validUntil? (epoch ms) }.
// Resolves to { ok, status: 'added'|'updated', store }; throws on failure.
export async function addToRvList(deal) {
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in')
  const token = await user.getIdToken()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(deal),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

// A ✓ marker only means "already on this week's list", so it expires after a
// week: by then the shopping trip is done and the deal should be sendable
// again. Evaluated when a screen renders, i.e. next time the page is opened.
export const RV_SENT_TTL = 7 * 24 * 60 * 60 * 1000

// Keys ("itemId|recId") of the deals in db.rvSent still marked as sent.
export function rvSentKeys(rvSent, now = Date.now()) {
  return new Set(
    (rvSent ?? [])
      .filter((s) => now - (s.ts ?? 0) < RV_SENT_TTL)
      .map((s) => `${s.itemId}|${s.recId}`),
  )
}

// Drop markers that no longer mean anything — a week old, or pointing at a
// record that's gone or expired. Run inside `update` on each successful send.
export function pruneRvSent(next, now = Date.now()) {
  next.rvSent = (next.rvSent ?? []).filter((s) => {
    if (now - (s.ts ?? 0) >= RV_SENT_TTL) return false
    const rec = next.records.find((r) => r.id === s.recId)
    return rec && (rec.validUntil == null || rec.validUntil >= now)
  })
}
