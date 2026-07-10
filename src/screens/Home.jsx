import { Fragment, useMemo, useState } from 'react'
import { uid } from '../lib/db'
import { storeLogo } from '../lib/logos'
import { fmtDisplay } from '../lib/units'
import { meatDeals, MEAT_TYPES, MEAT_TYPE_LABEL, RATING } from '../lib/meat'

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

      <MeatDeals db={db} push={push} />

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

// Current best meat deal per product, grouped Beef/Pork/Chicken/Fish, natural
// products first with ultra-processed under their own subheading. Expired
// flyer deals never show; manual prices (no validUntil) always qualify.
function MeatDeals({ db, push }) {
  const groups = useMemo(() => meatDeals(db), [db])
  const types = MEAT_TYPES.filter((t) => groups[t]?.length)
  if (!types.length) return null

  return (
    <div className="meat-deals" style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>🥩 Meat deals</h2>
      {types.map((t) => {
        const firstUltra = groups[t].findIndex((d) => d.ultra)
        return (
          <div key={t} style={{ marginTop: 10 }}>
            <div className="lbl" style={{ marginBottom: 4 }}>{MEAT_TYPE_LABEL[t]}</div>
            <div className="card list" style={{ padding: '2px 14px' }}>
              {groups[t].map((d, idx) => (
                <Fragment key={d.item.id}>
                  {idx === firstUltra && (
                    <div className="sub" style={{ padding: '8px 2px 0', color: 'var(--muted)', fontSize: 12 }}>
                      Ultra-processed
                    </div>
                  )}
                  <button className="row" onClick={() => push({ name: 'item', itemId: d.item.id })}>
                    <div className="grow">
                      <div className="title">{d.item.name}</div>
                      <div className="sub">
                        cheapest @ {d.store.name}
                        {d.rec.validUntil ? ` · until ${new Date(d.rec.validUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
                      </div>
                    </div>
                    <div className="right">
                      <div className="title">{fmtDisplay(d.norm, d.item.kind, db.displayWeightUnit)}</div>
                      {d.rating && <span className={`badge ${RATING[d.rating].cls}`}>{RATING[d.rating].label}</span>}
                    </div>
                  </button>
                </Fragment>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
