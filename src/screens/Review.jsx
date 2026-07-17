import { useEffect, useRef, useState } from 'react'
import { uid } from '../lib/db'
import { unitKind, fmtQty } from '../lib/units'
import { guessMeatType, GROCERY_TYPE_LABEL } from '../lib/meat'
import { addPhoto, photoUrl, removePhoto } from '../lib/photos'
import { storeLogo } from '../lib/logos'
import { toast } from '../lib/toast'
import StoreSheet from '../components/StoreSheet'

// 📷 Review — the photo-mode inbox (BUSINESS_RULES §15). Photos snapped
// in-store sit here as "pending" until the daily processing job extracts
// them (product, price, qty/unit, category); each extracted entry becomes a
// big card with every field visible, so the only decision is ✓ Approve or
// ✏️ Edit — no drilling into items one by one.
export default function Review({ db, update, push }) {
  const queue = [...(db.photoQueue ?? [])].sort((a, b) => b.ts - a.ts)
  const ready = queue.filter((p) => p.status === 'ready')
  const pending = queue.filter((p) => p.status === 'pending')
  const failed = queue.filter((p) => p.status === 'failed')
  const cameraRef = useRef(null)
  const [storeSheet, setStoreSheet] = useState(false)
  const [snapState, setSnapState] = useState(null)

  const currentStore = db.stores.find((s) => s.id === db.currentStoreId)

  async function snap(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setSnapState('busy')
    try {
      await addPhoto(update, file, currentStore.id)
      toast('Photo queued 📷')
      navigator.vibrate?.(15)
    } catch (err) {
      console.error('photo upload failed', err)
      toast(`⚠️ Photo upload failed: ${err.message}`)
    } finally {
      setSnapState(null)
    }
  }

  // Approve an extracted entry against the draft db: reuse the matched item
  // or create it, append the record (ts = when the photo was taken,
  // source 'photo'), drop the queue entry. Runs inside update()'s mutate so
  // "Approve all" sees items created by earlier entries in the same batch.
  function applyEntry(d, entry) {
    const meat = entry.category === 'meat'
    let item =
      d.items.find((i) => i.id === entry.matchedItemId) ??
      d.items.find((i) => i.name.toLowerCase() === (entry.itemName ?? '').toLowerCase())
    if (!item) {
      item = {
        id: uid('i'),
        name: entry.itemName,
        category: meat ? 'meat' : 'other',
        kind: unitKind(entry.unit),
        defaultUnit: entry.unit,
        annualQty: null,
        meatType: meat ? guessMeatType(entry.itemName) : null,
        processing: meat ? (entry.processing ?? 'natural') : null,
        groceryType: meat ? undefined : entry.groceryType ?? undefined,
        market: null,
      }
      d.items.push(item)
    }
    d.records.push({
      id: uid('r'),
      itemId: item.id,
      storeId: entry.storeId,
      price: entry.price,
      qty: entry.qty,
      unit: entry.unit,
      frozen: meat ? !!entry.frozen : null,
      bones: meat ? !!entry.bones : null,
      skin: meat ? !!entry.skin : null,
      ts: entry.ts,
      source: 'photo',
    })
    d.photoQueue = (d.photoQueue ?? []).filter((p) => p.id !== entry.id)
  }

  function approve(entry) {
    update((d) => applyEntry(d, entry))
    toast(`Saved ${entry.itemName} — $${entry.price}`)
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
      <div className="topbar" style={{ justifyContent: 'space-between' }}>
        <h1>Review 📷</h1>
        <button
          className="btn small tonal"
          disabled={snapState === 'busy'}
          onClick={() => (currentStore ? cameraRef.current?.click() : setStoreSheet(true))}
        >
          {snapState === 'busy' ? 'Uploading…' : '📷 Snap label'}
        </button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={snap} />
      </div>

      {queue.length === 0 && (
        <div className="empty">
          <div className="ico">📷</div>
          Nothing to review.
          <div className="sub small" style={{ marginTop: 8, lineHeight: 1.5 }}>
            In a store, snap a photo of a shelf label (here or from the add screen).
            The daily 9:20 job reads it and the extracted price shows up here to approve.
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
          onApprove={() => approve(entry)}
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

      {storeSheet && (
        <StoreSheet
          db={db}
          update={update}
          onClose={() => setStoreSheet(false)}
          onPick={() => toast('Store set 📍 — now snap the label')}
        />
      )}
    </div>
  )
}

function ReadyCard({ entry, db, onApprove, onEdit, onDiscard }) {
  const store = db.stores.find((s) => s.id === entry.storeId)
  const meat = entry.category === 'meat'
  const matched =
    db.items.find((i) => i.id === entry.matchedItemId) ??
    db.items.find((i) => i.name.toLowerCase() === (entry.itemName ?? '').toLowerCase())
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
        {matched
          ? <span className="badge lvl-first">matches “{matched.name}”</span>
          : <span className="badge lvl-ok">new product</span>}
        {entry.note && <span className="badge">💬 {entry.note}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="icon-btn" aria-label="Discard" onClick={onDiscard}>🗑️</button>
        <button className="btn ghost" style={{ flex: 1 }} onClick={onEdit}>✏️ Edit</button>
        <button className="btn" style={{ flex: 2 }} onClick={onApprove}>✓ Approve</button>
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
