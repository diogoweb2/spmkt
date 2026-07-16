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
