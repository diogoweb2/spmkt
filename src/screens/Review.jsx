import { useEffect, useState } from 'react'
import { fmtQty, unitKind } from '../lib/units'
import { GROCERY_TYPE_LABEL } from '../lib/meat'
import { photoUrl, removePhoto, applyEntry } from '../lib/photos'
import { storeLogo } from '../lib/logos'
import { toast } from '../lib/toast'
import { mergeSuggestions, mergeItems, suggestName, groupIds } from '../lib/merge'
import { SuggestionList, MergeNameDialog } from '../components/MergeSuggest'

// 📷 Review — the photo-mode inbox (BUSINESS_RULES §15). Photos are captured
// via the ➕ FAB's "Photo batch" action (§9b) and sit here as "pending" until
// the daily processing job extracts them (product, price, qty/unit,
// category); each extracted entry becomes a big card with every field
// visible, so the only decision is ✓ Approve or ✏️ Edit — no drilling into
// items one by one.
export default function Review({ db, update, push }) {
  // Pending merge (§15d): { entry, ids, names, name } while the name dialog is
  // open, after approving a card with look-alike products selected.
  const [merge, setMerge] = useState(null)
  const queue = [...(db.photoQueue ?? [])].sort((a, b) => b.ts - a.ts)
  const ready = queue.filter((p) => p.status === 'ready')
  const pending = queue.filter((p) => p.status === 'pending')
  const failed = queue.filter((p) => p.status === 'failed')

  // Approving uses the shared applyEntry (src/lib/photos.js) — also used by
  // ⚡ Photo Live — run inside update()'s mutate so "Approve all" sees items
  // created by earlier entries in the same batch.
  // Approve with no merge picks: just apply. With picks, apply first (so the
  // entry's item exists and carries its price) and then ask for the group name.
  function approve(entry, picked = []) {
    if (!picked.length) {
      update((d) => applyEntry(d, entry))
      toast(`Saved ${entry.itemName} — $${entry.price}`)
      return
    }
    let itemId
    update((d) => { itemId = applyEntry(d, entry) })
    const items = [
      db.items.find((i) => i.id === itemId) ?? { id: itemId, name: entry.itemName },
      ...picked.map((id) => db.items.find((i) => i.id === id)),
    ].filter(Boolean)
    const counts = {}
    for (const r of db.records) counts[r.itemId] = (counts[r.itemId] ?? 0) + 1
    setMerge({
      ids: [itemId, ...picked],
      names: items.map((i) => i.name),
      name: suggestName(items, counts, groupIds(db)),
    })
  }

  function confirmMerge() {
    const name = merge.name.trim()
    if (!name) return
    update((d) => mergeItems(d, merge.ids, name))
    setMerge(null)
    toast(`Merged into “${name}”`)
  }

  function approveAll() {
    const batch = ready
    update((d) => batch.forEach((entry) => applyEntry(d, entry)))
    toast(`Saved ${batch.length} prices ✓`)
  }

  function discard(entry) {
    const snapshot = structuredClone(entry)
    removePhoto(update, entry)
    toast('Photo discarded', {
      undo: () =>
        update((d) => {
          d.photoQueue ??= []
          d.photoQueue.push(snapshot)
        }),
    })
  }

  return (
    <div className="screen">
      <div className="topbar">
        <h1>Review 📷</h1>
      </div>

      {queue.length === 0 && (
        <div className="empty">
          <div className="ico">📷</div>
          Nothing to review.
          <div className="sub small" style={{ marginTop: 8, lineHeight: 1.5 }}>
            In a store, tap ➕ → 📷 Photo batch to snap shelf labels.
            The daily 9:20 job reads them and the extracted prices show up here to approve.
          </div>
        </div>
      )}

      {ready.length > 1 && (
        <button className="btn" style={{ marginBottom: 12 }} onClick={approveAll}>
          ✓ Approve all ({ready.length})
        </button>
      )}

      {ready.map((entry) => (
        <ReadyCard
          key={entry.id}
          entry={entry}
          db={db}
          onApprove={(picked) => approve(entry, picked)}
          onEdit={() => push({ name: 'addPrice', storeId: entry.storeId, photoId: entry.id })}
          onDiscard={() => discard(entry)}
        />
      ))}

      {pending.length > 0 && (
        <>
          <div className="lbl" style={{ margin: '14px 0 6px' }}>Waiting for processing</div>
          {pending.map((entry) => (
            <PendingCard key={entry.id} entry={entry} db={db} onDiscard={() => discard(entry)} />
          ))}
          <p className="muted small" style={{ marginTop: 4 }}>
            Photos are read automatically every morning at 9:20 (or run <code>npm run photos</code> on the Mac).
          </p>
        </>
      )}

      {failed.length > 0 && (
        <>
          <div className="lbl" style={{ margin: '14px 0 6px' }}>Failed</div>
          {failed.map((entry) => (
            <div key={entry.id} className="card review-card">
              <div className="rc-name">⚠️ Couldn't read this photo</div>
              <p className="muted small" style={{ margin: '6px 0 12px' }}>{entry.error ?? 'Extraction failed.'}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" onClick={() => discard(entry)}>Discard</button>
                <button
                  className="btn tonal"
                  onClick={() => push({ name: 'addPrice', storeId: entry.storeId ?? db.currentStoreId, photoId: entry.id })}
                >
                  ✏️ Enter manually
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {merge && (
        <MergeNameDialog
          names={merge.names}
          value={merge.name}
          onChange={(name) => setMerge((m) => ({ ...m, name }))}
          onCancel={() => setMerge(null)}
          onConfirm={confirmMerge}
        />
      )}
    </div>
  )
}

function ReadyCard({ entry, db, onApprove, onEdit, onDiscard }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState([])
  const store = db.stores.find((s) => s.id === entry.storeId)
  const meat = entry.category === 'meat'
  const matched =
    db.items.find((i) => i.id === entry.matchedItemId) ??
    db.items.find((i) => i.name.toLowerCase() === (entry.itemName ?? '').toLowerCase())
  // Look-alike products for this extraction (§15d): compared against the
  // matched item if there is one, otherwise the item this entry would create.
  const probe = matched ?? { id: null, name: entry.itemName, kind: unitKind(entry.unit) }
  const suggestions = mergeSuggestions(db, probe)
  return (
    <div className="card review-card">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div className="rc-name" style={{ flex: 1, minWidth: 0 }}>{entry.itemName}</div>
        <div className="rc-price">
          ${entry.price}{entry.qty === 1 ? `/${entry.unit}` : ` · ${fmtQty(entry.qty, entry.unit)}`}
        </div>
      </div>
      <div className="rc-grid">
        {store && (
          <span className="badge">
            {storeLogo(store.name)
              ? <img src={storeLogo(store.name)} alt={store.name} style={{ height: 13, verticalAlign: 'middle' }} />
              : store.name}
          </span>
        )}
        <span className="badge">{new Date(entry.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        <span className="badge">{meat ? '🥩 Meat' : GROCERY_TYPE_LABEL[entry.groceryType] ?? '📦 Other'}</span>
        {meat && <span className="badge">{entry.frozen ? '❄️ frozen' : '🥩 fresh'}</span>}
        {meat && <span className="badge">{entry.bones ? '🦴 bone-in' : 'boneless'}</span>}
        {meat && <span className="badge">{entry.skin ? 'skin-on' : 'skinless'}</span>}
        {entry.minQty >= 2 && <span className="badge lvl-ok" title={`price requires buying ${entry.minQty} or more`}>🛒 buy {entry.minQty}+</span>}
        {matched
          ? <span className="badge lvl-first">matches “{matched.name}”</span>
          : <span className="badge lvl-ok">new product</span>}
        {entry.note && <span className="badge">💬 {entry.note}</span>}
      </div>

      {suggestions.length > 0 && (
        <>
          <button type="button" className="ms-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? '▴' : '▾'} 🔗 {suggestions.length} similar product{suggestions.length === 1 ? '' : 's'}
            {picked.length ? ` · ${picked.length} to merge` : ''}
          </button>
          {open && (
            <SuggestionList
              db={db}
              suggestions={suggestions}
              selected={picked}
              onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
            />
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="icon-btn" aria-label="Discard" onClick={onDiscard}>🗑️</button>
        <button className="btn ghost" style={{ flex: 1 }} onClick={onEdit}>✏️ Edit</button>
        <button className="btn" style={{ flex: 2 }} onClick={() => onApprove(picked)}>
          {picked.length ? `✓ Approve & merge (${picked.length + 1})` : '✓ Approve'}
        </button>
      </div>
    </div>
  )
}

function PendingCard({ entry, db, onDiscard }) {
  const [url, setUrl] = useState(null)
  const [broken, setBroken] = useState(false)
  const store = db.stores.find((s) => s.id === entry.storeId)
  useEffect(() => {
    let on = true
    photoUrl(entry)
      .then((u) => on && setUrl(u))
      .catch((e) => {
        // Preview needs Storage read permission (deploy storage.rules); the
        // photo is still processed server-side regardless. Show a placeholder
        // rather than an endless skeleton.
        if (on) { setBroken(true); console.warn('photo preview unavailable:', e.code ?? e.message) }
      })
    return () => { on = false }
  }, [entry])
  const thumbStyle = { width: 74, height: 74, flexShrink: 0, borderRadius: 10 }
  return (
    <div className="card review-card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      {broken
        ? <div style={{ ...thumbStyle, display: 'grid', placeItems: 'center', fontSize: 28, background: 'var(--md-surface-container)' }}>📷</div>
        : url
        ? <img src={url} alt="queued label" onError={() => setBroken(true)} style={{ ...thumbStyle, objectFit: 'cover' }} />
        : <div className="skeleton" style={thumbStyle} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="title small" style={{ fontWeight: 700 }}>
          {store?.name ?? 'Unknown store'} · {new Date(entry.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </div>
        <div className="sub muted small">waiting for the daily extraction…</div>
      </div>
      <button className="icon-btn" aria-label="Discard photo" onClick={onDiscard}>🗑️</button>
    </div>
  )
}
