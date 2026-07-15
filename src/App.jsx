import { useState, useEffect, useCallback } from 'react'
import { watchAuth, signOutUser } from './lib/firebase'
import { ensureDB, subscribeDB, saveDB } from './lib/db'
import SignInScreen from './screens/SignInScreen'
import Home from './screens/Home'
import Location from './screens/Location'
import AddPrice from './screens/AddPrice'
import ItemDetail from './screens/ItemDetail'
import Items from './screens/Items'
import Settings from './screens/Settings'
import { cashbackEnabled } from './lib/cashback'

export default function App() {
  const [user, setUser] = useState(undefined) // undefined = auth loading, null = signed out
  const [db, setDb] = useState(null)
  const [stack, setStack] = useState([{ name: 'home' }])

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

  if (user === null) {
    return (
      <div className="app">
        <SignInScreen />
      </div>
    )
  }

  if (!db) {
    return (
      <div className="app">
        <div className="pin-screen">
          <div className="pin-logo">🛒</div>
          <h1>Smart Price</h1>
          <p className="muted" style={{ marginTop: 6 }}>Loading…</p>
        </div>
      </div>
    )
  }

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

  return (
    <div className="app">
      <button
        className={`cashback-pill${cb ? ' on' : ''}`}
        title={cb ? 'Prices shown after card cashback — tap to see shelf prices' : 'Showing shelf prices — tap to apply card cashback'}
        onClick={() => update((d) => { d.cashback = !cb })}
      >
        💳 {cb ? 'on' : 'off'}
      </button>
      {view.name === 'home' && <Home {...props} />}
      {view.name === 'location' && <Location {...props} />}
      {view.name === 'addPrice' && <AddPrice {...props} />}
      {view.name === 'item' && <ItemDetail {...props} />}
      {view.name === 'items' && <Items {...props} />}
      {view.name === 'settings' && <Settings {...props} onSignOut={() => signOutUser()} />}

      <nav className="nav">
        <NavBtn ico="🏠" label="Home" on={view.name === 'home'} onClick={() => goTab('home')} />
        <NavBtn ico="📍" label="Location" on={['location', 'addPrice'].includes(view.name)} onClick={() => goTab('location')} />
        <NavBtn ico="📋" label="Items" on={['items', 'item'].includes(view.name)} onClick={() => goTab('items')} />
        <NavBtn ico="⚙️" label="Settings" on={view.name === 'settings'} onClick={() => goTab('settings')} />
      </nav>
    </div>
  )
}

function NavBtn({ ico, label, on, onClick }) {
  return (
    <button className={on ? 'on' : ''} onClick={onClick}>
      <span className="ico">{ico}</span>
      {label}
    </button>
  )
}
