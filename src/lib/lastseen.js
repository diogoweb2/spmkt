// "Where was the product I just looked at?" — a product page is opened from a
// long Home list (or landed on right after saving a price), and coming back
// remounts Home scrolled to the top, so the row is lost. The id of the last
// product page opened is parked here; Home marks that row and scrolls it into
// view (§9b).
//
// sessionStorage, not the db: it is per-tab UI state, worthless to sync, and
// must survive Home unmounting while the product page is on the stack.
const KEY = 'spmkt.lastItem'

// Only honoured for a few minutes — after that the user is browsing fresh and
// a jump to some product they opened earlier would be a surprise, not a help.
const FRESH_MS = 5 * 60 * 1000

export function markSeen(itemId) {
  if (!itemId) return
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ id: itemId, ts: Date.now() }))
  } catch { /* private mode / storage disabled: the highlight is optional */ }
}

// The product to highlight now, or null.
export function lastSeenItem() {
  try {
    const { id, ts } = JSON.parse(sessionStorage.getItem(KEY) || 'null') ?? {}
    return id && Date.now() - ts < FRESH_MS ? id : null
  } catch { return null }
}
