import { useState, useEffect, useCallback } from 'react'
import { watchAuth, signOutUser } from './lib/firebase'
import { ensureDB, subscribeDB, saveDB } from './lib/db'
import SignInScreen from './screens/SignInScreen'
import Home from './screens/Home'
import AddPrice from './screens/AddPrice'
import ItemDetail from './screens/ItemDetail'
import Review from './screens/Review'
import Settings from './screens/Settings'
import Snackbar from './components/Snackbar'
import StoreSheet from './components/StoreSheet'
import { cashbackEnabled } from './lib/cashback'
import { reviewCount } from './lib/photos'

// Navigation: three destinations (Home · Review · Settings) plus a center
// ➕ FAB that jumps straight into logging a price at the current store (the
// store sheet asks "Where are you?" first when none is set). Bottom nav bar
// on mobile, navigation rail on desktop (≥900px). Detail screens (item,
// addPrice) are pushed onto the view stack, mirrored into browser history.
export default function App() {
  const [user, setUser] = useState(undefined) // undefined = auth loading, null = signed out
  const [db, setDb] = useState(null)
  const [stack, setStack] = useState([{ name: 'home' }])
  const [storeSheet, setStoreSheet] = useState(false) // FAB pressed with no store set

  useEffect(() => watchAuth(setUser), [])

  // Browser-history integration: every push/tab change becomes a history
  // entry (hash = view name), so the browser Back button navigates inside
  // the app instead of leaving it.
  useEffect(() => {
    window.history.replaceState({ stack: [{ name: 'home' }] }, '', '#home')
    const onPop = (e) => setStack(e.state?.stack ?? [{ name: 'home' }])
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (!user) {
      setDb(null)
      return
    }
    let unsub = () => {}
    let cancelled = false
    ensureDB(user.uid).then(() => {
      if (!cancelled) unsub = subscribeDB(user.uid, setDb)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [user])

  const update = useCallback(
    (mutate) => {
      setDb((prev) => {
        const next = structuredClone(prev)
        mutate(next)
        saveDB(user.uid, next)
        return next
      })
    },
    [user],
  )

  // Desktop keyboard shortcuts: "/" focuses the visible search field,
  // Escape goes back (or blurs the focused input).
  useEffect(() => {
    const onKey = (e) => {
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)
      if (e.key === '/' && !inField) {
        const search = document.querySelector('.screen input[type="search"]')
        if (search) {
          e.preventDefault()
          search.focus()
          search.select?.()
        }
      } else if (e.key === 'Escape') {
        if (inField) document.activeElement.blur()
        else if (window.history.state?.stack?.length > 1) window.history.back()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (user === null) {
    return (
      <div className="app">
        <SignInScreen />
      </div>
    )
  }

  if (!db) return <LoadingSkeleton />

  const view = stack[stack.length - 1]
  const navigate = (next) => {
    window.history.pushState({ stack: next }, '', `#${next[next.length - 1].name}`)
    setStack(next)
  }
  const push = (v) => navigate([...stack, v])
  const pop = () => (stack.length > 1 ? window.history.back() : undefined)
  const goTab = (name) => navigate([{ name }])

  const props = { db, update, push, pop, view }

  const cb = cashbackEnabled(db)
  const wu = db.displayWeightUnit ?? 'lb'
  const nReview = reviewCount(db)
  const tab = ['item', 'addPrice'].includes(view.name) ? null : view.name

  // ➕ FAB: log a price where you are; ask for the store first if unknown.
  const startAdd = () => {
    const store = db.stores.find((s) => s.id === db.currentStoreId)
    if (store) push({ name: 'addPrice', storeId: store.id })
    else setStoreSheet(true)
  }

  const destinations = (
    <>
      <NavBtn ico="🏠" label="Home" on={tab === 'home'} onClick={() => goTab('home')} />
      <NavBtn ico="📷" label="Review" on={tab === 'review'} badge={nReview} onClick={() => goTab('review')} />
      <NavBtn ico="⚙️" label="Settings" on={tab === 'settings'} onClick={() => goTab('settings')} />
    </>
  )

  return (
    <div className="app">
      {/* desktop navigation rail */}
      <nav className="rail">
        <button className="rail-fab" title="Add a price (at your current store)" onClick={startAdd}>＋</button>
        {destinations}
      </nav>

      <div className="content">
        <div className="global-pills">
          <button
            className="cashback-pill on"
            title={`Weight prices shown per ${wu} — tap to switch to $/${wu === 'lb' ? 'kg' : 'lb'}`}
            onClick={() => update((d) => { d.displayWeightUnit = wu === 'lb' ? 'kg' : 'lb' })}
          >
            ⚖️ $/{wu}
          </button>
          <button
            className={`cashback-pill${cb ? ' on' : ''}`}
            title={cb ? 'Prices shown after card cashback — tap to see shelf prices' : 'Showing shelf prices — tap to apply card cashback'}
            onClick={() => update((d) => { d.cashback = !cb })}
          >
            💳 {cb ? 'on' : 'off'}
          </button>
        </div>

        {view.name === 'home' && <Home {...props} />}
        {view.name === 'addPrice' && <AddPrice {...props} />}
        {view.name === 'item' && <ItemDetail {...props} />}
        {view.name === 'review' && <Review {...props} />}
        {view.name === 'settings' && <Settings {...props} onSignOut={() => signOutUser()} />}
      </div>

      {/* mobile: center FAB above the nav bar */}
      {tab && <button className="fab" aria-label="Add a price" onClick={startAdd}>＋</button>}

      <nav className="nav">{destinations}</nav>

      {storeSheet && (
        <StoreSheet
          db={db}
          update={update}
          onClose={() => setStoreSheet(false)}
          onPick={(store) => push({ name: 'addPrice', storeId: store.id })}
        />
      )}

      <Snackbar />
    </div>
  )
}

function NavBtn({ ico, label, on, badge, onClick }) {
  return (
    <button className={`rail-dest${on ? ' on' : ''}`} onClick={onClick}>
      <span className="ico">{ico}</span>
      {label}
      {badge > 0 && <span className="nbadge">{badge}</span>}
    </button>
  )
}

// Shimmer placeholder while Firestore loads the family db.
function LoadingSkeleton() {
  return (
    <div className="app">
      <div className="screen" style={{ maxWidth: 560, margin: '0 auto' }}>
        <div className="skeleton" style={{ height: 32, width: 180, marginBottom: 18 }} />
        <div className="skeleton" style={{ height: 44, borderRadius: 999, marginBottom: 14 }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {[70, 90, 80, 60].map((w, i) => (
            <div key={i} className="skeleton" style={{ height: 30, width: w, borderRadius: 999 }} />
          ))}
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" style={{ height: 74, marginBottom: 10 }} />
        ))}
      </div>
    </div>
  )
}
