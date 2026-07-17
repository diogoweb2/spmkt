import { useState, useEffect, useCallback, useRef } from 'react'
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
import { reviewCount, addPhoto } from './lib/photos'
import { toast } from './lib/toast'

// How long a "Where are you?" confirmation stays fresh — the store sheet
// doesn't nag again within this window (§9b).
const STORE_CONFIRM_MS = 60 * 60 * 1000
const STORE_CONFIRM_KEY = 'spmkt.storeConfirmedAt'

// Navigation: three destinations (Home · Review · Settings) plus a center
// ➕ FAB that opens an Android-style menu — Manual entry or Photo batch. The
// pick is confirmed against the current store ("Where are you?"), then runs;
// that confirmation is skipped for an hour after each pick. Bottom nav bar on
// mobile, navigation rail on desktop (≥900px). Detail screens (item,
// addPrice) are pushed onto the view stack, mirrored into browser history.
export default function App() {
  const [user, setUser] = useState(undefined) // undefined = auth loading, null = signed out
  const [db, setDb] = useState(null)
  const [stack, setStack] = useState([{ name: 'home' }])
  const [storeSheet, setStoreSheet] = useState(false) // store confirm before an add action
  const [fabMenu, setFabMenu] = useState(false) // ➕ speed-dial open
  const pendingAction = useRef(null) // 'manual' | 'photo' — chosen action awaiting store confirm
  const cameraRef = useRef(null)
  const photoStoreRef = useRef(null) // storeId stamped on batch photos

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

  // Run the chosen ➕ action at a confirmed store: manual → AddPrice form;
  // photo → open the camera (batch capture) stamped with that store.
  const runAction = (action, storeId) => {
    if (action === 'photo') {
      photoStoreRef.current = storeId
      cameraRef.current?.click()
    } else {
      push({ name: 'addPrice', storeId })
    }
  }

  // ➕ menu pick: confirm the store first ("Where are you?") unless we have a
  // store and confirmed it within the last hour; then run the action.
  const chooseAction = (action) => {
    setFabMenu(false)
    const store = db.stores.find((s) => s.id === db.currentStoreId)
    const confirmedAt = Number(localStorage.getItem(STORE_CONFIRM_KEY) || 0)
    const fresh = Date.now() - confirmedAt < STORE_CONFIRM_MS
    if (store && fresh) {
      runAction(action, store.id)
    } else {
      pendingAction.current = action
      setStoreSheet(true)
    }
  }

  // Batch photo capture: queue every selected shot for the confirmed store.
  const snapPhotos = async (e) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    const storeId = photoStoreRef.current
    if (!files.length || !storeId) return
    try {
      for (const file of files) await addPhoto(update, file, storeId)
      toast(`${files.length} photo${files.length === 1 ? '' : 's'} queued 📷`)
      navigator.vibrate?.(15)
    } catch (err) {
      console.error('photo upload failed', err)
      toast(`⚠️ Photo upload failed: ${err.message}`)
    }
  }

  const addMenu = (
    <div className="fab-menu">
      <button className="fab-action" onClick={() => chooseAction('manual')}>
        <span className="mini">✏️</span> Manual entry
      </button>
      <button className="fab-action" onClick={() => chooseAction('photo')}>
        <span className="mini">📷</span> Photo batch
      </button>
    </div>
  )

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
        <div className="rail-fab-wrap">
          <button
            className={`rail-fab${fabMenu ? ' open' : ''}`}
            title="Add a price"
            aria-expanded={fabMenu}
            onClick={() => setFabMenu((v) => !v)}
          >
            ＋
          </button>
          {fabMenu && <div className="rail-menu">{addMenu}</div>}
        </div>
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

      {/* mobile: center FAB (speed dial) above the nav bar */}
      {tab && (
        <div className="fab-wrap">
          {fabMenu && addMenu}
          <button
            className={`fab${fabMenu ? ' open' : ''}`}
            aria-label="Add a price"
            aria-expanded={fabMenu}
            onClick={() => setFabMenu((v) => !v)}
          >
            ＋
          </button>
        </div>
      )}

      {fabMenu && <div className="fab-scrim" onClick={() => setFabMenu(false)} />}

      <nav className="nav">{destinations}</nav>

      {storeSheet && (
        <StoreSheet
          db={db}
          update={update}
          onClose={() => setStoreSheet(false)}
          onPick={(store) => {
            localStorage.setItem(STORE_CONFIRM_KEY, String(Date.now()))
            runAction(pendingAction.current ?? 'manual', store.id)
          }}
        />
      )}

      {/* hidden batch camera input for the ➕ → Photo batch action */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        onChange={snapPhotos}
      />

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
