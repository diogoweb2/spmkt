import { useState } from 'react'
import { applyEntry, addPhoto } from '../lib/photos'
import { GROCERY_TYPE_LABEL } from '../lib/meat'
import { storeLogo } from '../lib/logos'
import { toast } from '../lib/toast'
import { mergeSuggestions, mergeItems, suggestName, groupIds } from '../lib/merge'
import { SuggestionList, MergeNameDialog } from './MergeSuggest'

const ALL_UNITS = ['kg', 'lb', 'g', 'oz', 'L', 'ml', 'un']

// ⚡ Photo Live confirm sheet (BUSINESS_RULES §15a). Shown right after the
// FAB's "Photo live" shot: a spinner while OpenRouter reads the label, then
// the extraction with the essentials editable inline (name, price, qty, unit,
// meat flags) — ✓ Save applies it on the spot and opens the product page.
// ✏️ Edit hands off to the full AddPrice form (via a ready photoQueue entry);
// a failure offers Retry or queueing the shot for the daily batch job.
export default function LiveSheet({ db, update, live, onClose, onRetry, onEdit, onSaved }) {
  // After ✓ Save: the id of the item just written, when look-alike products
  // exist and the user still has to decide about merging (§15d).
  const [mergeFor, setMergeFor] = useState(null)

  // Saving hands off to the merge step when there is something to suggest;
  // otherwise straight to the product page.
  function afterSave(itemId) {
    const item = db.items.find((i) => i.id === itemId)
    const suggestions = item ? mergeSuggestions(db, item) : []
    if (suggestions.length) setMergeFor(itemId)
    else onSaved(itemId)
  }

  if (mergeFor) {
    return (
      <MergeStep
        db={db}
        update={update}
        itemId={mergeFor}
        onDone={(finalId) => { setMergeFor(null); onSaved(finalId) }}
      />
    )
  }

  return (
    <div className="modal-backdrop sheet" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        {live.status === 'loading' && (
          <div style={{ textAlign: 'center', padding: '18px 0 26px' }}>
            <div style={{ fontSize: 34 }}>⚡</div>
            <h2 style={{ marginBottom: 4 }}>Reading the label…</h2>
            <p className="muted small">A couple of seconds.</p>
            <div className="skeleton" style={{ height: 12, borderRadius: 999, marginTop: 16 }} />
            <button className="btn ghost" style={{ marginTop: 16 }} onClick={onClose}>Cancel</button>
          </div>
        )}
        {live.status === 'error' && <ErrorBody live={live} update={update} onClose={onClose} onRetry={onRetry} />}
        {live.status === 'ready' && (
          <ReadyBody db={db} update={update} entry={live.entry} onClose={onClose} onEdit={onEdit} onSaved={afterSave} />
        )}
      </div>
    </div>
  )
}

// Step 2 of ⚡ Photo Live: "is this the same product as…?" (§15d). Pure
// name-similarity suggestions — no AI. Skipping goes to the item just saved;
// merging asks for the final name and then opens the merged group's page.
function MergeStep({ db, update, itemId, onDone }) {
  const item = db.items.find((i) => i.id === itemId)
  const [picked, setPicked] = useState([])
  const [name, setName] = useState(null) // non-null = naming dialog open
  const suggestions = item ? mergeSuggestions(db, item) : []

  if (!item) return null

  function startMerge() {
    const items = [item, ...picked.map((id) => db.items.find((i) => i.id === id))].filter(Boolean)
    const counts = {}
    for (const r of db.records) counts[r.itemId] = (counts[r.itemId] ?? 0) + 1
    setName(suggestName(items, counts, groupIds(db)))
  }

  function confirm() {
    const final = name.trim()
    if (!final) return
    // The saved item is first, so it keeps its id — the page we open next.
    update((d) => mergeItems(d, [item.id, ...picked], final))
    toast(`Merged into “${final}”`)
    onDone(item.id)
  }

  if (name != null) {
    return (
      <MergeNameDialog
        names={[item.name, ...picked.map((id) => db.items.find((i) => i.id === id)?.name).filter(Boolean)]}
        value={name}
        onChange={setName}
        onCancel={() => setName(null)}
        onConfirm={confirm}
      />
    )
  }

  return (
    <div className="modal-backdrop sheet" onClick={() => onDone(item.id)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>🔗 Same product?</h2>
        <p className="muted small" style={{ marginTop: -4 }}>
          You already track products that look like <b>{item.name}</b>. Pick the ones that
          are really the same thing — tap ▾ to see the names behind a group.
        </p>
        <SuggestionList
          db={db}
          suggestions={suggestions}
          selected={picked}
          onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => onDone(item.id)}>
            Keep separate
          </button>
          <button className="btn" style={{ flex: 2 }} disabled={!picked.length} onClick={startMerge}>
            🔗 Merge {picked.length ? `(${picked.length + 1})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

function ErrorBody({ live, update, onClose, onRetry }) {
  const [queueing, setQueueing] = useState(false)
  async function queueForBatch() {
    setQueueing(true)
    try {
      await addPhoto(update, live.file, live.storeId)
      toast('Photo queued for the daily batch 📷')
      onClose()
    } catch (err) {
      toast(`⚠️ Could not queue the photo: ${err.message}`)
      setQueueing(false)
    }
  }
  return (
    <>
      <h2>⚠️ Couldn't read the label</h2>
      <p className="muted small" style={{ margin: '4px 0 16px' }}>{live.error}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn" onClick={onRetry}>↻ Try again</button>
        <button className="btn tonal" disabled={queueing} onClick={queueForBatch}>
          {queueing ? 'Queueing…' : '📷 Queue for the daily batch instead'}
        </button>
        <button className="btn ghost" onClick={onClose}>Discard</button>
      </div>
    </>
  )
}

function ReadyBody({ db, update, entry, onClose, onEdit, onSaved }) {
  const [name, setName] = useState(entry.itemName)
  const [price, setPrice] = useState(String(entry.price))
  const [qty, setQty] = useState(String(entry.qty))
  const [unit, setUnit] = useState(entry.unit)
  const [frozen, setFrozen] = useState(!!entry.frozen)
  const [bones, setBones] = useState(!!entry.bones)
  const [skin, setSkin] = useState(!!entry.skin)

  const meat = entry.category === 'meat'
  const store = db.stores.find((s) => s.id === entry.storeId)
  const matched =
    db.items.find((i) => i.id === entry.matchedItemId) ??
    db.items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase())
  const priceNum = parseFloat(price)
  const qtyNum = parseFloat(qty)
  const valid = name.trim() && priceNum > 0 && qtyNum > 0

  // Current sheet state as a queue-shaped entry (edits included).
  const edited = () => ({
    ...entry,
    itemName: name.trim(),
    matchedItemId: matched?.id ?? null,
    price: Math.round(priceNum * 100) / 100,
    qty: qtyNum,
    unit,
    ...(meat ? { frozen, bones, skin } : {}),
  })

  function save() {
    if (!valid) return
    let itemId
    update((d) => { itemId = applyEntry(d, edited()) })
    toast(`Saved ${name.trim()} — $${priceNum}`)
    onSaved(itemId)
  }

  const Flag = ({ on, set, yes, no }) => (
    <button type="button" className={`badge${on ? ' lvl-first' : ''}`} style={{ cursor: 'pointer' }} onClick={() => set(!on)}>
      {on ? yes : no}
    </button>
  )

  return (
    <>
      <h2>⚡ Confirm price</h2>
      <label className="lbl" style={{ marginTop: 6 }}>Product</label>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <div style={{ flex: 1 }}>
          <label className="lbl">Price $</label>
          <input type="number" inputMode="decimal" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div style={{ width: 90 }}>
          <label className="lbl">Qty</label>
          <input type="number" inputMode="decimal" step="any" min="0" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div style={{ width: 84 }}>
          <label className="lbl">Unit</label>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} style={{ width: '100%' }}>
            {ALL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
      </div>
      <div className="rc-grid" style={{ marginTop: 12 }}>
        {store && (
          <span className="badge">
            {storeLogo(store.name)
              ? <img src={storeLogo(store.name)} alt={store.name} style={{ height: 13, verticalAlign: 'middle' }} />
              : store.name}
          </span>
        )}
        <span className="badge">{meat ? '🥩 Meat' : GROCERY_TYPE_LABEL[entry.groceryType] ?? '📦 Other'}</span>
        {meat && <Flag on={frozen} set={setFrozen} yes="❄️ frozen" no="🥩 fresh" />}
        {meat && <Flag on={bones} set={setBones} yes="🦴 bone-in" no="boneless" />}
        {meat && <Flag on={skin} set={setSkin} yes="skin-on" no="skinless" />}
        {matched
          ? <span className="badge lvl-first">matches “{matched.name}”</span>
          : <span className="badge lvl-ok">new product</span>}
        {entry.note && <span className="badge">💬 {entry.note}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="icon-btn" aria-label="Discard" onClick={onClose}>🗑️</button>
        <button className="btn ghost" style={{ flex: 1 }} onClick={() => onEdit(edited())}>✏️ Edit</button>
        <button className="btn" style={{ flex: 2 }} disabled={!valid} onClick={save}>✓ Save</button>
      </div>
    </>
  )
}
