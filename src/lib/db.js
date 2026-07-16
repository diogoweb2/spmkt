// Data layer backed by Firestore: each user's whole db lives in one doc, users/{uid}.
// Pre-Firebase (phase 1) data in localStorage is migrated up on first sign-in.

import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore'
import { firestore } from './firebase'

const LEGACY_KEY = 'smartprice-db-v1'

export const DEFAULT_DB = {
  displayWeightUnit: 'lb', // how weight prices are shown: 'lb' or 'kg'
  cashback: true, // apply card cashback to all prices (src/lib/cashback.js); Settings toggle
  currentStoreId: null, // where the user is right now; remembered until changed
  stores: [
    { id: 's-costco', name: 'Costco', color: '#e11d48', defaultUnit: 'kg' },
    { id: 's-walmart', name: 'Walmart', color: '#2563eb', defaultUnit: 'lb' },
    { id: 's-nofrills', name: 'No Frills', color: '#f59e0b', defaultUnit: 'lb' },
  ],
  items: [], // {id, name, category, kind, defaultUnit, annualQty|null, meatType|null, processing|null, market|null}
  records: [], // {id, itemId, storeId, price, qty, unit, frozen|null, ts}
  notes: [], // {id, type: 'bug'|'idea', text, done, ts}
  ignored: [], // {id, name, ts} — products the user deleted & ignored; flyer import skips their kind
  pushTokens: [], // {token, ua, ts} — FCM web-push tokens; the flyer job notifies these devices
  rvSent: [], // {itemId, recId, ts} — deals sent to the RV Groceries app; keeps the ✓ on the deal row while that record is still the current deal (one-way: nothing in the RV app ever syncs back)
}

function userDoc(userId) {
  return doc(firestore, 'users', userId)
}

// One-time setup: if the user has no cloud db yet, seed it from the old
// localStorage db (phase-1 migration) or the defaults. Returns nothing;
// subscribeDB delivers the resulting data.
export async function ensureDB(userId) {
  const snap = await getDoc(userDoc(userId))
  if (snap.exists()) return
  let seed = structuredClone(DEFAULT_DB)
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) {
      const legacy = JSON.parse(raw)
      delete legacy.pinHash // PIN is replaced by Google sign-in
      seed = { ...seed, ...legacy }
    }
  } catch { /* corrupted legacy data: start from defaults */ }
  await setDoc(userDoc(userId), seed)
  localStorage.removeItem(LEGACY_KEY)
}

// Live-syncs the user's db; cb(db) fires on load and whenever another device
// writes. Local writes are echoed immediately from cache. Returns unsubscribe.
export function subscribeDB(userId, cb) {
  return onSnapshot(userDoc(userId), (snap) => {
    if (snap.exists()) cb({ ...structuredClone(DEFAULT_DB), ...snap.data() })
  })
}

export function saveDB(userId, db) {
  return setDoc(userDoc(userId), db)
}

export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function exportJSON(db) {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `smartprice-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
