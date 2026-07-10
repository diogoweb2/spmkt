import { useMemo, useState } from 'react'
import { uid } from '../lib/db'
import { suggestedUnit, suggestedQty, itemRecords } from '../lib/analysis'
import { KIND_UNITS, unitKind } from '../lib/units'

const CATEGORIES = [
  { id: 'meat', label: '🥩 Meat' },
  { id: 'other', label: '📦 Other' },
]

const ALL_UNITS = ['kg', 'lb', 'g', 'oz', 'L', 'ml', 'un']

export default function AddPrice({ db, update, push, pop, view }) {
  const store = db.stores.find((s) => s.id === view.storeId)

  // Opened from the Items tab with a product (or a search term) already chosen
  const presetItem = db.items.find((i) => i.id === view.presetItemId) ?? null
  const presetLast = presetItem ? itemRecords(db, presetItem.id)[0] : null

  const [query, setQuery] = useState(presetItem?.name ?? view.presetQuery ?? '')
  const [item, setItem] = useState(presetItem) // existing item selected
  const [creating, setCreating] = useState(!presetItem && !!view.presetQuery)

  // form state
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState(() => (presetItem ? String(suggestedQty(db, presetItem, view.storeId)) : '1'))
  const [unit, setUnit] = useState(() =>
    presetItem ? suggestedUnit(db, presetItem, view.storeId) : store?.defaultUnit ?? 'lb',
  )
  const [category, setCategory] = useState(presetItem?.category ?? 'other')
  const [frozen, setFrozen] = useState(presetLast?.frozen ?? false)
  const [bones, setBones] = useState(presetLast?.bones ?? false)
  const [skin, setSkin] = useState(presetLast?.skin ?? false)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const scored = db.items
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .map((i) => ({ i, n: itemRecords(db, i.id).length }))
      .sort((a, b) => b.n - a.n)
    return scored.slice(0, q ? 6 : 8).map((s) => s.i)
  }, [db, query])

  function selectItem(it) {
    setItem(it)
    setCreating(false)
    setQuery(it.name)
    setUnit(suggestedUnit(db, it, store.id))
    setQty(String(suggestedQty(db, it, store.id)))
    setCategory(it.category)
    const last = itemRecords(db, it.id)[0]
    setFrozen(last?.frozen ?? false)
    setBones(last?.bones ?? false)
    setSkin(last?.skin ?? false)
  }

  function startCreate() {
    setItem(null)
    setCreating(true)
    setUnit(store?.defaultUnit ?? 'lb')
    setQty('1')
  }

  const formVisible = item || creating
  const isMeat = category === 'meat'
  const priceNum = parseFloat(price)
  const qtyNum = parseFloat(qty)
  const valid = formVisible && priceNum > 0 && qtyNum > 0 && (item || query.trim())

  function save() {
    if (!valid) return
    let itemId = item?.id
    update((d) => {
      if (!itemId) {
        itemId = uid('i')
        d.items.push({
          id: itemId,
          name: query.trim(),
          category,
          kind: unitKind(unit),
          defaultUnit: unit,
          annualQty: null,
          // Meat classification: manual items default to natural; the weekly
          // LLM pass fills meatType and market thresholds (BUSINESS_RULES §13).
          meatType: null,
          processing: category === 'meat' ? 'natural' : null,
          market: null,
        })
      }
      const meat = (item ? item.category : category) === 'meat'
      d.records.push({
        id: uid('r'),
        itemId,
        storeId: store.id,
        price: priceNum,
        qty: qtyNum,
        unit,
        frozen: meat ? frozen : null,
        bones: meat ? bones : null,
        skin: meat ? skin : null,
        ts: Date.now(),
      })
    })
    push({ name: 'item', itemId, fromSave: !byPiece })
  }

  if (!store) return null

  // Units compatible with an existing item's kind; new items can pick anything.
  // Meat is sold by the piece too ("3 pieces $8", no weight printed) — allow
  // `un` on weight meat items; such records are history-only (never compared).
  const meatItem = (item ?? { category }).category === 'meat'
  const unitChoices = item
    ? meatItem && item.kind === 'weight' ? [...KIND_UNITS.weight, 'un'] : KIND_UNITS[item.kind]
    : ALL_UNITS
  const byPiece = item && unitKind(unit) !== item.kind

  return (
    <div className="screen">
      <div className="topbar">
        <button className="back" onClick={pop}>‹</button>
        <h1 style={{ color: store.color }}>{store.name}</h1>
      </div>

      <label className="field">
        <span className="lbl">Product</span>
        <input
          type="search"
          autoFocus={!formVisible}
          placeholder="Milk, chicken breast, cereal…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setItem(null)
            setCreating(false)
          }}
        />
      </label>

      {!formVisible && (
        <div className="suggestions list">
          {matches.map((it) => (
            <button key={it.id} className="row" onClick={() => selectItem(it)}>
              <div className="grow">
                <div className="title">{it.name}</div>
                <div className="sub">{it.category === 'meat' ? '🥩 Meat' : '📦 ' + (it.category !== 'other' ? it.category : 'Other')}</div>
              </div>
              <span className="chev">›</span>
            </button>
          ))}
          {query.trim() && !db.items.some((i) => i.name.toLowerCase() === query.trim().toLowerCase()) && (
            <button className="row" onClick={startCreate}>
              <div className="grow">
                <div className="title" style={{ color: 'var(--accent)' }}>+ Add “{query.trim()}”</div>
                <div className="sub">New product</div>
              </div>
            </button>
          )}
          {!query.trim() && matches.length === 0 && (
            <div className="empty small" style={{ padding: 24 }}>
              Type a product name to add it.
            </div>
          )}
        </div>
      )}

      {formVisible && (
        <>
          {creating && (
            <label className="field">
              <span className="lbl">Category</span>
              <div className="seg">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={category === c.id ? 'on' : ''}
                    onClick={() => setCategory(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </label>
          )}

          <label className="field">
            <span className="lbl">Price</span>
            <div className="price-input">
              <span>$</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                autoFocus={formVisible}
                placeholder="0.00"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
          </label>

          <div style={{ display: 'flex', gap: 10 }}>
            <label className="field" style={{ flex: 1 }}>
              <span className="lbl">Quantity</span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span className="lbl">Unit</span>
              <div className="seg">
                {unitChoices.map((u) => (
                  <button key={u} type="button" className={unit === u ? 'on' : ''} onClick={() => setUnit(u)}>
                    {u}
                  </button>
                ))}
              </div>
            </label>
          </div>

          {byPiece && (
            <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
              ⚠️ No weight given — saved for history, but it can't be compared with $/{db.displayWeightUnit ?? 'lb'} prices.
            </p>
          )}

          {isMeat && (
            <>
              <label className="field">
                <span className="lbl">Fresh or frozen?</span>
                <div className="seg">
                  <button type="button" className={!frozen ? 'on' : ''} onClick={() => setFrozen(false)}>
                    🥩 Fresh
                  </button>
                  <button type="button" className={frozen ? 'on' : ''} onClick={() => setFrozen(true)}>
                    ❄️ Frozen
                  </button>
                </div>
              </label>
              <div style={{ display: 'flex', gap: 10 }}>
                <label className="field" style={{ flex: 1 }}>
                  <span className="lbl">Bones?</span>
                  <div className="seg">
                    <button type="button" className={!bones ? 'on' : ''} onClick={() => setBones(false)}>
                      No
                    </button>
                    <button type="button" className={bones ? 'on' : ''} onClick={() => setBones(true)}>
                      🦴 Yes
                    </button>
                  </div>
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span className="lbl">Skin?</span>
                  <div className="seg">
                    <button type="button" className={!skin ? 'on' : ''} onClick={() => setSkin(false)}>
                      No
                    </button>
                    <button type="button" className={skin ? 'on' : ''} onClick={() => setSkin(true)}>
                      Yes
                    </button>
                  </div>
                </label>
              </div>
            </>
          )}

          <button className="btn" disabled={!valid} onClick={save} style={{ marginTop: 8 }}>
            Save price
          </button>
        </>
      )}
    </div>
  )
}
