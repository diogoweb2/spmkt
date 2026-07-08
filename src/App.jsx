import { useState, useEffect, useCallback } from 'react'
import { watchAuth, signOutUser } from './lib/firebase'
import { ensureDB, subscribeDB, saveDB } from './lib/db'
import SignInScreen from './screens/SignInScreen'
import Home from './screens/Home'
import AddPrice from './screens/AddPrice'
import ItemDetail from './screens/ItemDetail'
import Items from './screens/Items'
import Settings from './screens/Settings'

export default function App() {
  const [user, setUser] = useState(undefined) // undefined = auth loading, null = signed out
  const [db, setDb] = useState(null)
  const [stack, setStack] = useState([{ name: 'home' }])

  useEffect(() => watchAuth(setUser), [])

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
  const push = (v) => setStack((s) => [...s, v])
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  const goTab = (name) => setStack([{ name }])

  const props = { db, update, push, pop, view }

  return (
    <div className="app">
      {view.name === 'home' && <Home {...props} />}
      {view.name === 'addPrice' && <AddPrice {...props} />}
      {view.name === 'item' && <ItemDetail {...props} />}
      {view.name === 'items' && <Items {...props} />}
      {view.name === 'settings' && <Settings {...props} onSignOut={() => signOutUser()} />}

      <nav className="nav">
        <NavBtn ico="🏪" label="Shop" on={['home', 'addPrice'].includes(view.name)} onClick={() => goTab('home')} />
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
