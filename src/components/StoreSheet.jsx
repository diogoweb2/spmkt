import { useState } from 'react'
import { uid } from '../lib/db'
import { storeLogo } from '../lib/logos'

const STORE_COLORS = ['#e11d48', '#2563eb', '#f59e0b', '#7c3aed', '#0d9488', '#db2777']

// "Where are you?" bottom sheet (centered dialog on desktop). Replaces the old
// Location tab: picking a store sets db.currentStoreId; "+ Add store" creates
// one and selects it. onPick(store) fires after the pick (used by the FAB flow
// to continue into AddPrice).
export default function StoreSheet({ db, update, onClose, onPick }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  function pick(store) {
    update((d) => { d.currentStoreId = store.id })
    onClose()
    onPick?.(store)
  }

  function addStore() {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = uid('s')
    const store = {
      id,
      name: trimmed,
      color: STORE_COLORS[db.stores.length % STORE_COLORS.length],
      defaultUnit: 'lb',
    }
    update((d) => {
      d.stores.push(store)
      d.currentStoreId = id
    })
    onClose()
    onPick?.(store)
  }

  return (
    <div className="modal-backdrop sheet" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>Where are you? 🛒</h2>
        <div className="store-grid">
          {db.stores.map((s) => {
            const count = db.records.filter((r) => r.storeId === s.id).length
            const logo = storeLogo(s.name)
            return (
              <button
                key={s.id}
                className={`store-btn${db.currentStoreId === s.id ? ' current' : ''}`}
                style={{ background: s.color }}
                onClick={() => pick(s)}
              >
                {logo ? (
                  <span className="store-logo"><img src={logo} alt={s.name} /></span>
                ) : (
                  s.name
                )}
                <span className="count">{count} price{count === 1 ? '' : 's'}</span>
              </button>
            )
          })}
          <button className="store-btn add" onClick={() => setAdding(true)}>+ Add store</button>
        </div>

        {adding && (
          <div style={{ marginTop: 14 }}>
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
    </div>
  )
}
