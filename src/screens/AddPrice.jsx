import { useMemo, useRef, useState } from 'react'
import { uid } from '../lib/db'
import { suggestedUnit, suggestedQty, itemRecords, recordNorm, pricesByStore } from '../lib/analysis'
import { KIND_UNITS, unitKind, fmtDisplay } from '../lib/units'
import { guessMeatType } from '../lib/meat'
import { cashbackRate } from '../lib/cashback'
import { addPhoto } from '../lib/photos'
import { toast } from '../lib/toast'

const CATEGORIES = [
  { id: 'meat', label: '🥩 Meat' },
  { id: 'other', label: '📦 Other' },
]

const ALL_UNITS = ['kg', 'lb', 'g', 'oz', 'L', 'ml', 'un']

// Store-mode add flow (BUSINESS_RULES §9): search-first; every match shows
// what YOU already logged at THIS store (price + date, pinned first) plus the
// cheapest other store, so "did I already add grapes at Costco?" answers
// itself. Picking a product with a price here prefills the full form from
// that record; saving a different price asks "new price vs correction", the
// same price is a friendly no-op. A 📷 button snaps the label for the Review
// queue instead of typing anything (photo mode, §15).
export default function AddPrice({ db, update, push, pop, view }) {
  const store = db.stores.find((s) => s.id === view.storeId)

  const presetItem = db.items.find((i) => i.id === view.presetItemId) ?? null
  // Edit mode: opened from a product's History to fix an existing record.
  const editRec = db.records.find((r) => r.id === view.editRecordId) ?? null
  // Photo mode: opened from Review's ✏️ Edit with extracted fields.
  const photoEntry = (db.photoQueue ?? []).find((p) => p.id === view.photoId) ?? null
  const photoItem = photoEntry?.itemName
    ? db.items.find((i) => i.name.toLowerCase() === photoEntry.itemName.toLowerCase()) ?? null
    : null

  // At this store, the item's latest record (any variant) — the "you logged
  // this here before" anchor for store mode.
  const lastAtStore = (itemId) =>
    itemRecords(db, itemId).find((r) => r.storeId === store?.id) ?? null

  const startItem = presetItem ?? photoItem
  // The item's last record at THIS store (prefills the whole form in store
  // mode); falls back to its latest record anywhere for the meat toggles.
  const startHere = startItem && !editRec ? lastAtStore(startItem.id) : null
  const startRec = editRec ?? startHere ?? (startItem ? itemRecords(db, startItem.id)[0] : null)

  const [query, setQuery] = useState(startItem?.name ?? photoEntry?.itemName ?? view.presetQuery ?? '')
  const [item, setItem] = useState(startItem)
  const [creating, setCreating] = useState(!startItem && !!(view.presetQuery || photoEntry?.itemName))

  // form state — photo extraction wins, then the record being edited/updated
  const [price, setPrice] = useState(
    photoEntry?.price != null ? String(photoEntry.price) : editRec ? String(editRec.price) : startHere ? String(startHere.price) : '',
  )
  const [qty, setQty] = useState(() =>
    photoEntry?.qty != null ? String(photoEntry.qty)
    : editRec ? String(editRec.qty)
    : startItem ? String(startHere ? startHere.qty : suggestedQty(db, startItem, view.storeId))
    : '1',
  )
  const [unit, setUnit] = useState(() =>
    photoEntry?.unit ?? (editRec ? editRec.unit
    : startItem ? (startHere ? startHere.unit : suggestedUnit(db, startItem, view.storeId))
    : store?.defaultUnit ?? 'lb'),
  )
  const [category, setCategory] = useState(photoEntry?.category ?? startItem?.category ?? 'other')
  const [processing, setProcessing] = useState(startItem?.processing ?? 'natural')
  const [pkgMode, setPkgMode] = useState(!!editRec && startItem?.category === 'meat' && editRec.qty !== 1)
  const [discount, setDiscount] = useState('')
  const [frozen, setFrozen] = useState(photoEntry?.frozen ?? startRec?.frozen ?? false)
  const [bones, setBones] = useState(photoEntry?.bones ?? startRec?.bones ?? false)
  const [skin, setSkin] = useState(photoEntry?.skin ?? startRec?.skin ?? false)
  // Optional "until <date>" — a limited-time price (in-store sale/tag) the user
  // types manually. Behaves exactly like a flyer deal: expires on that date and
  // shows the 📰 badge. Stored as a yyyy-mm-dd string in the date input.
  const [until, setUntil] = useState(() => {
    const v = editRec?.validUntil ?? photoEntry?.validUntil
    return v ? new Date(v).toISOString().slice(0, 10) : ''
  })
  // Optional multi-buy minimum ("2/$2.50" deals): the price is per item, but
  // only when buying at least N. Indicator only — comparisons are unchanged.
  const [minQty, setMinQty] = useState(() => {
    const v = photoEntry?.minQty ?? editRec?.minQty ?? startHere?.minQty
    return v >= 2 ? String(v) : ''
  })
  // "You paid a different price here before" dialog: null | {prevRec}
  const [priceChoice, setPriceChoice] = useState(null)
  const cameraRef = useRef(null)
  const [snapState, setSnapState] = useState(null) // 'busy' while uploading

  const matches = useMemo(() => {
    const qn = query.trim().toLowerCase()
    const scored = db.items
      .filter((i) => !qn || i.name.toLowerCase().includes(qn))
      .map((i) => {
        const here = lastAtStore(i.id)
        return { i, here, n: itemRecords(db, i.id).length }
      })
      // Items you already logged at this store first (most recent first),
      // then the rest by history size.
      .sort((a, b) => {
        if (!!b.here - !!a.here) return !!b.here - !!a.here
        if (a.here && b.here) return b.here.ts - a.here.ts
        return b.n - a.n
      })
    return scored.slice(0, qn ? 6 : 8)
  }, [db, query]) // eslint-disable-line react-hooks/exhaustive-deps

  function selectItem(it) {
    setItem(it)
    setCreating(false)
    setQuery(it.name)
    setCategory(it.category)
    const here = lastAtStore(it.id)
    const last = here ?? itemRecords(db, it.id)[0]
    // Store mode: prefill everything from this store's last record —
    // usually only the price needs a glance.
    setUnit(here ? here.unit : suggestedUnit(db, it, store.id))
    setQty(String(here ? here.qty : suggestedQty(db, it, store.id)))
    setPrice(here ? String(here.price) : '')
    setFrozen(last?.frozen ?? false)
    setBones(last?.bones ?? false)
    setSkin(last?.skin ?? false)
    setUntil(here?.validUntil ? new Date(here.validUntil).toISOString().slice(0, 10) : '')
    setMinQty(here?.minQty >= 2 ? String(here.minQty) : '')
  }

  function startCreate() {
    setItem(null)
    setCreating(true)
    setUnit(store?.defaultUnit ?? 'lb')
    setQty('1')
    setPrice('')
    setUntil('')
    setMinQty('')
  }

  const formVisible = item || creating
  const isMeat = category === 'meat'
  const isCostco = /costco/i.test(store?.name ?? '')
  const pkg = pkgMode && isMeat
  const labelMode = isMeat && !pkg
  const priceNum = parseFloat(price)
  const discountNum = pkg ? parseFloat(discount) || 0 : 0
  const effPrice = priceNum - discountNum
  const qtyNum = labelMode && unit !== 'un' ? 1 : parseFloat(qty)
  const valid = formVisible && effPrice > 0 && qtyNum > 0 && (item || query.trim())
  const cbRate = cashbackRate(db, store)
  const finalPrice = pkg ? Math.round(effPrice * 100) / 100 : priceNum
  // Parse the optional "until" date to end-of-day epoch ms (local), so the
  // price stays valid through the whole of that day. Empty → no expiry.
  const validUntil = until ? new Date(`${until}T23:59:59`).getTime() : null
  // Multi-buy minimum: whole number ≥ 2, anything else means "no minimum".
  const minQtyNum = /^\d+$/.test(minQty.trim()) && parseInt(minQty, 10) >= 2 ? parseInt(minQty, 10) : null

  const prevHere = item && !editRec ? lastAtStore(item.id) : null
  // Store mode is a shelf-tag match ("is the price still the same?"), so the
  // "here" figures show the raw shelf price — card cashback is ignored here
  // (it's baked in elsewhere, and shown live in the caption below the input).
  const prevHereNorm = prevHere && item ? recordNorm(prevHere, item) : null
  const cheapestElsewhere = item
    ? pricesByStore(db, item.id, null).find((e) => e.store.id !== store?.id)
    : null
  const cheapestElsewhereNorm = cheapestElsewhere ? recordNorm(cheapestElsewhere.rec, item) : null

  // Append a brand-new record (the normal path, and "it's a new price").
  function appendRecord(itemId, meat) {
    update((d) => {
      d.records.push({
        id: uid('r'),
        itemId,
        storeId: store.id,
        price: finalPrice,
        qty: qtyNum,
        unit,
        frozen: meat ? frozen : null,
        bones: meat ? bones : null,
        skin: meat ? skin : null,
        ts: photoEntry?.ts ?? Date.now(),
        ...(minQtyNum ? { minQty: minQtyNum } : {}),
        // A user-typed "until <date>" makes this a limited-time price that
        // expires and shows the 📰 badge — same handling as a flyer deal.
        ...(validUntil ? { source: 'flyer', validUntil } : {}),
        // A flyer-sourced review entry (an unsized `un` deal parked for its
        // weight, §12) keeps its ad link and shelf name when saved from here.
        ...(photoEntry?.source === 'flyer'
          ? {
              source: 'flyer',
              flyerUrl: photoEntry.flyerUrl ?? null,
              flyerPage: photoEntry.flyerPage ?? null,
              ...(photoEntry.origName && photoEntry.origName.toLowerCase() !== query.trim().toLowerCase() ? { origName: photoEntry.origName } : {}),
            }
          : {}),
      })
      if (photoEntry) d.photoQueue = (d.photoQueue ?? []).filter((p) => p.id !== photoEntry.id)
    })
    push({ name: 'item', itemId, fromSave: !byPiece })
  }

  // "I typed it wrong before": overwrite the previous record at this store.
  function correctRecord(meat) {
    update((d) => {
      const rec = d.records.find((r) => r.id === prevHere.id)
      if (!rec) return
      rec.price = finalPrice
      rec.qty = qtyNum
      rec.unit = unit
      rec.frozen = meat ? frozen : null
      rec.bones = meat ? bones : null
      rec.skin = meat ? skin : null
      if (minQtyNum) rec.minQty = minQtyNum
      else delete rec.minQty
      if (validUntil) { rec.source = 'flyer'; rec.validUntil = validUntil }
      else if (rec.source === 'flyer' && !rec.flyerUrl) { delete rec.source; delete rec.validUntil }
      if (photoEntry) d.photoQueue = (d.photoQueue ?? []).filter((p) => p.id !== photoEntry.id)
    })
    toast('Price corrected — history unchanged')
    push({ name: 'item', itemId: item.id })
  }

  function save() {
    if (!valid) return
    let itemId = item?.id

    if (editRec) {
      update((d) => {
        const rec = d.records.find((r) => r.id === editRec.id)
        const it = d.items.find((i) => i.id === itemId)
        const meat = category === 'meat'
        // Rename in place: the Product field is editable in edit mode, so a
        // typo'd name ("Chicken whole" → "Whole chicken") updates this item
        // instead of spinning up a new one.
        const newName = query.trim()
        if (newName) it.name = newName
        it.category = category
        it.processing = meat ? processing : null
        // Unit is editable here, so a wrong kind picked at creation ("un" on a
        // 2 L juice) can be corrected. Only adopt the new kind when no other
        // record disagrees — otherwise flipping it would silently strand every
        // sibling record as reference-only (§3).
        const newKind = unitKind(unit)
        const othersAgree = d.records.every(
          (r) => r.id === rec.id || r.itemId !== itemId || unitKind(r.unit) === newKind,
        )
        if (othersAgree && it.kind !== newKind) {
          it.kind = newKind
          it.defaultUnit = unit
        }
        rec.price = finalPrice
        rec.qty = qtyNum
        rec.unit = unit
        rec.frozen = meat ? frozen : null
        rec.bones = meat ? bones : null
        rec.skin = meat ? skin : null
        if (minQtyNum) rec.minQty = minQtyNum
        else delete rec.minQty
        // Manual "until" edit: set/clear the expiry window. Don't strip a real
        // flyer import's source (it keeps its url/page); only clear the window
        // for records that were manual "until" prices to begin with.
        if (validUntil) { rec.source = 'flyer'; rec.validUntil = validUntil }
        else if (rec.source === 'flyer' && !rec.flyerUrl) { delete rec.source; delete rec.validUntil }
      })
      pop()
      return
    }

    const meat = (item ? item.category : category) === 'meat'

    // Store mode: the item already has a price at this store.
    if (prevHere && item) {
      const same =
        prevHere.price === finalPrice && prevHere.qty === qtyNum && prevHere.unit === unit &&
        (prevHere.validUntil ?? null) === validUntil && (prevHere.minQty ?? null) === minQtyNum
      if (same) {
        toast('Same price as last time — nothing new to save 👍')
        push({ name: 'item', itemId: item.id })
        return
      }
      // Different price: new record, or fixing a typo?
      setPriceChoice({ meat })
      return
    }

    if (!itemId) {
      itemId = uid('i')
      update((d) => {
        d.items.push({
          id: itemId,
          name: query.trim(),
          category,
          kind: unitKind(unit),
          defaultUnit: unit,
          annualQty: null,
          meatType: category === 'meat' ? guessMeatType(query) : null,
          processing: category === 'meat' ? processing : null,
          market: null,
        })
      })
    }
    appendRecord(itemId, meat)
  }

  // 📷 photo mode: snap the label, deal with it later in Review.
  async function snap(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setSnapState('busy')
    try {
      await addPhoto(update, file, store.id)
      toast('Photo queued 📷 — extracted overnight, then it shows up in Review')
      navigator.vibrate?.(15)
    } catch (err) {
      console.error('photo upload failed', err)
      toast(`⚠️ Photo upload failed: ${err.message}`)
    } finally {
      setSnapState(null)
    }
  }

  if (!store) return null

  const meatItem = (item ?? { category }).category === 'meat'
  const unitChoices = meatItem
    ? pkg ? KIND_UNITS.weight : ['kg', 'lb', 'un']
    : editRec || !item ? ALL_UNITS : KIND_UNITS[item.kind]
  if (!unitChoices.includes(unit)) setUnit(unitChoices.includes(store?.defaultUnit) ? store.defaultUnit : unitChoices[0])
  const byPiece = item && unitKind(unit) !== item.kind

  const wu = db.displayWeightUnit ?? 'lb'

  return (
    <div className="screen" style={{ maxWidth: 640, margin: '0 auto' }}>
      <div className="topbar">
        <button className="back" onClick={pop}>‹</button>
        <div className="grow" style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ color: store.color }}>{store.name}</h1>
          {editRec && <span className="muted small">editing price from {new Date(editRec.ts).toLocaleDateString()}</span>}
          {photoEntry && <span className="muted small">from your photo 📷</span>}
        </div>
        {!editRec && (
          <>
            <button
              className="btn small tonal"
              disabled={snapState === 'busy'}
              title="Photo mode: snap the shelf label now, review the details later"
              onClick={() => cameraRef.current?.click()}
            >
              {snapState === 'busy' ? 'Uploading…' : '📷 Snap label'}
            </button>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={snap}
            />
          </>
        )}
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
            // Edit mode is a rename-in-place: keep the form (and the item we're
            // editing) put — the new text is saved onto the item, not treated
            // as a search for a different/new product.
            if (editRec) return
            setItem(null)
            setCreating(false)
          }}
        />
      </label>

      {!formVisible && (
        <div className="suggestions list">
          {matches.map(({ i: it, here }) => {
            const hereNorm = here ? recordNorm(here, it) : null
            return (
              <button key={it.id} className="row" onClick={() => selectItem(it)}>
                <div className="grow">
                  <div className="title">{it.name}</div>
                  <div className="sub">
                    {here ? (
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                        📍 here: {hereNorm != null ? fmtDisplay(hereNorm, it.kind, wu) : `$${here.price}`} · {new Date(here.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    ) : (
                      <span>{it.category === 'meat' ? '🥩 Meat' : '📦 ' + (it.category !== 'other' ? it.category : 'Other')} · never logged at {store.name}</span>
                    )}
                  </div>
                </div>
                <div className="right">
                  {here ? <span className="badge lvl-first">update</span> : <span className="chev">›</span>}
                </div>
              </button>
            )
          })}
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
          {prevHere && (
            <div className="card" style={{ padding: 12, background: 'var(--accent-soft)', borderColor: 'transparent' }}>
              <div className="small" style={{ fontWeight: 700 }}>
                📍 You logged this at {store.name}: {prevHereNorm != null ? fmtDisplay(prevHereNorm, item.kind, wu) : `$${prevHere.price}`}
                <span className="muted"> · {new Date(prevHere.ts).toLocaleDateString()}</span>
              </div>
              {cheapestElsewhere && (
                <div className="small muted" style={{ marginTop: 3 }}>
                  cheapest elsewhere: {fmtDisplay(cheapestElsewhereNorm, item.kind, wu)} at {cheapestElsewhere.store.name}
                </div>
              )}
              <div className="small muted" style={{ marginTop: 3 }}>
                Same price? Nothing to do. New price? Just change it below and save.
              </div>
            </div>
          )}

          {(creating || editRec) && (
            <label className="field">
              <span className="lbl">Category</span>
              <div className="seg">
                {CATEGORIES.map((c) => (
                  <button key={c.id} type="button" className={category === c.id ? 'on' : ''} onClick={() => setCategory(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
            </label>
          )}

          {(creating || editRec) && isMeat && (
            <label className="field">
              <span className="lbl">Processing</span>
              <div className="seg">
                <button type="button" className={processing === 'natural' ? 'on' : ''} onClick={() => { setProcessing('natural'); setFrozen(false) }}>
                  🥩 Natural
                </button>
                <button type="button" className={processing === 'ultra' ? 'on' : ''} onClick={() => { setProcessing('ultra'); setFrozen(true) }}>
                  🌭 Ultra-processed
                </button>
              </div>
            </label>
          )}

          {isMeat && (
            <label className="field">
              <span className="lbl">Price type</span>
              <div className="seg">
                <button type="button" className={!pkgMode ? 'on' : ''} onClick={() => setPkgMode(false)}>
                  🏷️ Label price
                </button>
                <button type="button" className={pkgMode ? 'on' : ''} onClick={() => setPkgMode(true)}>
                  📦 Package price
                </button>
              </div>
            </label>
          )}

          <label className="field">
            <span className="lbl">{pkg ? 'Package total price' : labelMode && unit !== 'un' ? `Price per ${unit}` : 'Price'}</span>
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

          {pkg && isCostco && (
            <label className="field">
              <span className="lbl">Discount sticker</span>
              <div className="price-input">
                <span>−$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </div>
            </label>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            {(!labelMode || unit === 'un') && (
              <label className="field" style={{ flex: 1 }}>
                <span className="lbl">{pkg ? 'Weight' : labelMode ? 'Pieces' : 'Quantity'}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
              </label>
            )}
            <label className="field" style={{ flex: 2 }}>
              <span className="lbl">{labelMode ? 'Per' : 'Unit'}</span>
              <div className="seg">
                {unitChoices.map((u) => (
                  <button key={u} type="button" className={unit === u ? 'on' : ''} onClick={() => setUnit(u)}>
                    {u}
                  </button>
                ))}
              </div>
            </label>
          </div>

          {pkg && effPrice > 0 && qtyNum > 0 && (
            <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
              = ${effPrice.toFixed(2)} for {qtyNum} {unit} → ${(effPrice / qtyNum).toFixed(2)}/{unit}
            </p>
          )}

          {cbRate > 0 && effPrice > 0 && qtyNum > 0 && (
            <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
              💳 after {(cbRate * 100).toFixed(1).replace('.0', '')}% cashback: $
              {((effPrice / qtyNum) * (1 - cbRate)).toFixed(2)}/{unit} — compared this way everywhere
            </p>
          )}

          {byPiece && (
            <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
              ⚠️ No weight given — saved for history, but it can't be compared with $/{wu} prices.
            </p>
          )}

          {isMeat && (
            <>
              <label className="field">
                <span className="lbl">Fresh or frozen?</span>
                <div className="seg">
                  <button type="button" className={!frozen ? 'on' : ''} onClick={() => setFrozen(false)}>🥩 Fresh</button>
                  <button type="button" className={frozen ? 'on' : ''} onClick={() => setFrozen(true)}>❄️ Frozen</button>
                </div>
              </label>
              <div style={{ display: 'flex', gap: 10 }}>
                <label className="field" style={{ flex: 1 }}>
                  <span className="lbl">Bones?</span>
                  <div className="seg">
                    <button type="button" className={!bones ? 'on' : ''} onClick={() => setBones(false)}>No</button>
                    <button type="button" className={bones ? 'on' : ''} onClick={() => setBones(true)}>🦴 Yes</button>
                  </div>
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span className="lbl">Skin?</span>
                  <div className="seg">
                    <button type="button" className={!skin ? 'on' : ''} onClick={() => setSkin(false)}>No</button>
                    <button type="button" className={skin ? 'on' : ''} onClick={() => setSkin(true)}>Yes</button>
                  </div>
                </label>
              </div>
            </>
          )}

          <label className="field">
            <span className="lbl">Multi-buy minimum <span className="muted">(optional)</span></span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min="2"
              placeholder="e.g. 2 for a “2/$2.50” deal"
              value={minQty}
              onChange={(e) => setMinQty(e.target.value)}
            />
            {minQtyNum ? (
              <span className="muted small" style={{ marginTop: 4 }}>
                🛒 Price is per item, but only when buying {minQtyNum}+
                {finalPrice > 0 ? ` (${minQtyNum} × $${finalPrice.toFixed(2)} = $${(minQtyNum * finalPrice).toFixed(2)})` : ''}.
              </span>
            ) : (
              <span className="muted small" style={{ marginTop: 4 }}>
                For “2/$2.50”-style deals: enter the per-item price above and the minimum here.
              </span>
            )}
          </label>

          <label className="field">
            <span className="lbl">Sale until <span className="muted">(optional)</span></span>
            <input
              type="date"
              value={until}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setUntil(e.target.value)}
            />
            {until ? (
              <span className="muted small" style={{ marginTop: 4 }}>
                📰 Limited-time price — expires after {new Date(`${until}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, like a flyer deal.
              </span>
            ) : (
              <span className="muted small" style={{ marginTop: 4 }}>
                Set a date for a temporary in-store sale; leave empty for a regular price.
              </span>
            )}
          </label>

          <button className="btn" disabled={!valid} onClick={save} style={{ marginTop: 8 }}>
            {editRec ? 'Save changes' : prevHere ? 'Save price at ' + store.name : 'Save price'}
          </button>
        </>
      )}

      {/* new price vs correction (BUSINESS_RULES §1: prices are append-only,
          corrections are the explicit exception) */}
      {priceChoice && (
        <div className="modal-backdrop sheet" onClick={() => setPriceChoice(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <h2>Different price than before</h2>
            <p className="muted small" style={{ marginBottom: 14 }}>
              You logged ${prevHere.price} here on {new Date(prevHere.ts).toLocaleDateString()} — now ${finalPrice}. Which is it?
            </p>
            <button
              className="btn"
              style={{ marginBottom: 8 }}
              onClick={() => { setPriceChoice(null); appendRecord(item.id, priceChoice.meat) }}
            >
              📈 New price — add to history
            </button>
            <button
              className="btn tonal"
              style={{ marginBottom: 8 }}
              onClick={() => { setPriceChoice(null); correctRecord(priceChoice.meat) }}
            >
              ✏️ I typed it wrong before — fix it
            </button>
            <button className="btn ghost" onClick={() => setPriceChoice(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
