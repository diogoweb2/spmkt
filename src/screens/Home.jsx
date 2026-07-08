import { useState } from 'react'
import { uid } from '../lib/db'
import { storeLogo } from '../lib/logos'

const STORE_COLORS = ['#e11d48', '#2563eb', '#f59e0b', '#7c3aed', '#0d9488', '#db2777']

export default function Home({ db, update, push }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  function addStore() {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = uid('s')
    update((d) => {
      d.stores.push({
        id,
        name: trimmed,
        color: STORE_COLORS[d.stores.length % STORE_COLORS.length],
        defaultUnit: 'lb',
      })
      d.currentStoreId = id
    })
    setName('')
    setAdding(false)
    push({ name: 'addPrice', storeId: id })
  }

  return (
    <div className="screen">
      <div className="topbar">
        <h1>Where are you? 🛒</h1>
      </div>

      <div className="store-grid">
        {db.stores.map((s) => {
          const count = db.records.filter((r) => r.storeId === s.id).length
          const logo = storeLogo(s.name)
          return (
            <button
              key={s.id}
              className="store-btn"
              style={{ background: s.color }}
              onClick={() => {
                update((d) => { d.currentStoreId = s.id })
                push({ name: 'addPrice', storeId: s.id })
              }}
            >
              {logo ? (
                <span className="store-logo">
                  <img src={logo} alt={s.name} />
                </span>
              ) : (
                s.name
              )}
              <span className="count">{count} price{count === 1 ? '' : 's'} logged</span>
            </button>
          )
        })}
        <button className="store-btn add" onClick={() => setAdding(true)}>
          + Add store
        </button>
      </div>

      {adding && (
        <div className="card" style={{ marginTop: 14 }}>
          <label className="field">
            <span className="lbl">Store name</span>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addStore()}
              placeholder="e.g. Food Basics"
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" disabled={!name.trim()} onClick={addStore}>Add</button>
          </div>
        </div>
      )}
    </div>
  )
}
