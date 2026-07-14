// Card cashback: every grocery purchase earns cashback, so the *effective*
// price is lower than the shelf price. Mastercard gives 1.5% everywhere;
// Amex gives 5% at specific chains. When enabled (default), all displayed
// prices AND all comparison math use the effective (post-cashback) price —
// a 5% store can genuinely beat a 1.5% store on the same shelf price.
// Toggled off via Settings (`db.cashback === false`).

const AMEX_RATE = 0.05
const DEFAULT_RATE = 0.015 // Mastercard, everywhere else

// Chains where the Amex 5% applies; matched loosely on the store name.
const AMEX_STORES = [
  /\bmetro\b/,
  /food\s*basics/,
  /sobeys/,
  /freshco/,
  /longo/,
  /whole\s*foods/,
  /farm\s*boy/,
]

export function cashbackEnabled(db) {
  return db?.cashback !== false
}

// Cashback rate for a store (by object or id). 0 when the feature is off.
export function cashbackRate(db, store) {
  if (!cashbackEnabled(db)) return 0
  const s = typeof store === 'string' ? db.stores.find((x) => x.id === store) : store
  if (!s) return 0
  const name = s.name.toLowerCase()
  return AMEX_STORES.some((re) => re.test(name)) ? AMEX_RATE : DEFAULT_RATE
}

// Multiplier applied to prices: 1 when off, 0.95 at Amex stores, 0.985 elsewhere.
export function cashbackFactor(db, store) {
  return 1 - cashbackRate(db, store)
}

// Effective price of a record after its store's cashback.
export function effectivePrice(db, rec) {
  return rec.price * cashbackFactor(db, rec.storeId)
}
