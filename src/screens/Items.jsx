import { useMemo, useRef, useState } from 'react'
import { itemRecords, recordNorm, pricesByStore, variantKey, variantLabel, flyerInfo } from '../lib/analysis'
import { fmtDisplay, fmtMoney, fmtQty } from '../lib/units'
import { effectivePrice } from '../lib/cashback'
import { canMerge, mergeItems, suggestName, targetUnit } from '../lib/merge'
import { ignoreItems } from '../lib/ignore'
import UnitToggle from '../components/UnitToggle'

export default function Items({ db, update, push }) {
  const [q, setQ] = useState('')
  const [comparing, setComparing] = useState(false)
  const [selected, setSelected] = useState([]) // keys "itemId|variant"
  const [report, setReport] = useState(false)
  // Hold a row to enter selection mode; selection is per item (all its variants).
  // From there: merge duplicates, or delete & ignore products you don't care about.
  const [merging, setMerging] = useState(false)
  const [mergeSel, setMergeSel] = useState([]) // item ids
  const [mergeName, setMergeName] = useState(null) // merge dialog open when a string
  const [confirmIgnore, setConfirmIgnore] = useState(false)
  const press = useRef({ timer: null, long: false })
  // Adding a price needs a store: ask once, then remember (db.currentStoreId)
  const [pendingAdd, setPendingAdd] = useState(null) // {itemId} | {query}

  const currentStore = db.stores.find((s) => s.id === db.currentStoreId)

  function goAdd(target, storeId) {
    setPendingAdd(null)
    push({
      name: 'addPrice',
      storeId,
      presetItemId: target.itemId,
      presetQuery: target.query,
    })
  }

  function startAdd(target) {
    if (currentStore) goAdd(target, currentStore.id)
    else setPendingAdd(target)
  }

  // One row per item variation (e.g. chicken breast skinless/boneless/frozen).
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase()
    const out = []
    for (const item of db.items) {
      if (query && !item.name.toLowerCase().includes(query)) continue
      const recs = itemRecords(db, item.id)
      if (recs.length === 0) {
        out.push({ item, variant: '', label: '', recs: [], key: item.id + '|' })
        continue
      }
      const byVariant = new Map()
      for (const r of recs) {
        const key = variantKey(r)
        if (!byVariant.has(key)) byVariant.set(key, [])
        byVariant.get(key).push(r)
      }
      for (const [variant, vrecs] of byVariant) {
        out.push({ item, variant, label: variantLabel(vrecs[0]), recs: vrecs, key: item.id + '|' + variant })
      }
    }
    return out.sort((a, b) => (b.recs[0]?.ts ?? 0) - (a.recs[0]?.ts ?? 0))
  }, [db, q])

  const allRows = useMemo(() => {
    const out = []
    for (const item of db.items) {
      const recs = itemRecords(db, item.id)
      const byVariant = new Map()
      for (const r of recs) {
        const key = variantKey(r)
        if (!byVariant.has(key)) byVariant.set(key, [])
        byVariant.get(key).push(r)
      }
      for (const [variant, vrecs] of byVariant) {
        out.push({ item, variant, label: variantLabel(vrecs[0]), recs: vrecs, key: item.id + '|' + variant })
      }
    }
    return out
  }, [db])

  const selectedRows = allRows.filter((r) => selected.includes(r.key))
  const compareKind = selectedRows[0]?.item.kind ?? null

  function toggleSelect(row) {
    if (row.recs.length === 0 || !pricesByStore(db, row.item.id, row.variant).length) return
    setSelected((sel) =>
      sel.includes(row.key) ? sel.filter((k) => k !== row.key) : [...sel, row.key],
    )
  }

  function exitCompare() {
    setComparing(false)
    setSelected([])
    setReport(false)
  }

  const mergeItemsSel = mergeSel.map((id) => db.items.find((i) => i.id === id)).filter(Boolean)
  const mergeRecs = db.records.filter((r) => mergeSel.includes(r.itemId))
  const recordCounts = Object.fromEntries(mergeItemsSel.map((i) => [i.id, itemRecords(db, i.id).length]))

  function holdStart(item) {
    if (comparing) return
    press.current.long = false
    press.current.timer = setTimeout(() => {
      press.current.long = true
      setMerging(true)
      setMergeSel([item.id])
      navigator.vibrate?.(20)
    }, 450)
  }

  function holdEnd() {
    clearTimeout(press.current.timer)
  }

  function toggleMerge(item) {
    setMergeSel((sel) =>
      sel.includes(item.id) ? sel.filter((id) => id !== item.id) : [...sel, item.id],
    )
  }

  function exitMerge() {
    setMerging(false)
    setMergeSel([])
    setMergeName(null)
    setConfirmIgnore(false)
  }

  function doMerge() {
    const name = mergeName.trim()
    if (!name) return
    const ids = mergeSel
    update((d) => mergeItems(d, ids, name))
    exitMerge()
  }

  function doIgnore() {
    const ids = mergeSel
    update((d) => ignoreItems(d, ids))
    exitMerge()
  }

  if (report && selectedRows.length >= 2) {
    return (
      <CompareReport
        db={db}
        rows={selectedRows}
        onBack={() => setReport(false)}
        onDone={exitCompare}
      />
    )
  }

  return (
    <div className="screen" style={comparing || merging ? { paddingBottom: 170 } : undefined}>
      <div className="topbar">
        <h1>{comparing ? 'Pick items ⚖️' : merging ? 'Selected products' : 'Your items 📋'}</h1>
        {!comparing && !merging && <UnitToggle db={db} update={update} />}
        {!comparing && !merging && allRows.filter((r) => r.recs.length).length >= 2 && (
          <button className="btn small ghost" onClick={() => setComparing(true)}>
            ⚖️ Compare
          </button>
        )}
      </div>

      {comparing && (
        <p className="muted small" style={{ marginTop: -8, marginBottom: 10 }}>
          Tap the products you want to compare — only same-type items (weight with weight).
        </p>
      )}

      {merging && (
        <p className="muted small" style={{ marginTop: -8, marginBottom: 10 }}>
          Tap more products to select them. Merge duplicates, or delete & ignore what you don't care about.
        </p>
      )}

      {!comparing && !merging && currentStore && (
        <button
          className="badge lvl-first"
          style={{ border: 'none', cursor: 'pointer', marginTop: -8, marginBottom: 10, fontSize: 12, padding: '5px 10px' }}
          onClick={() => setPendingAdd({ changeOnly: true })}
        >
          📍 You're at {currentStore.name} · change
        </button>
      )}

      <label className="field">
        <input type="search" placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>

      {rows.length === 0 && (
        <div className="empty">
          <div className="ico">🧺</div>
          {q ? 'No items match.' : 'No items yet — log a price from the Shop tab.'}
        </div>
      )}

      {!comparing && !merging && q.trim() && !db.items.some((i) => i.name.toLowerCase() === q.trim().toLowerCase()) && (
        <button className="btn ghost" style={{ marginBottom: 14 }} onClick={() => startAdd({ query: q.trim() })}>
          + Add “{q.trim()}” with a price
        </button>
      )}

      {rows.length > 0 && (
      <div className="card list" style={{ padding: '2px 14px' }}>
        {rows.map((row) => {
          const { item, variant, label, recs, key } = row
          const cheapest = pricesByStore(db, item.id, variant)[0]
          const norms = recs.map((r) => recordNorm(r, item, db)).filter((n) => n != null)
          const best = norms.length ? Math.min(...norms) : null
          const isMergeSel = merging && mergeSel.includes(item.id)
          const isSel = selected.includes(key) || isMergeSel
          // By-piece-only products have no normalized price: nothing to compare.
          const disabled =
            comparing && (recs.length === 0 || best == null || (compareKind && item.kind !== compareKind && !isSel))
          return (
            <button
              key={key}
              className="row"
              style={{
                ...(isSel ? { background: 'var(--accent-soft)', borderRadius: 10, padding: '13px 8px' } : null),
                ...(disabled ? { opacity: 0.35 } : null),
              }}
              onPointerDown={() => !merging && holdStart(item)}
              onPointerUp={holdEnd}
              onPointerLeave={holdEnd}
              onPointerCancel={holdEnd}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => {
                if (press.current.long) { press.current.long = false; return }
                if (merging) return !disabled && toggleMerge(item)
                if (comparing) return !disabled && toggleSelect(row)
                push({ name: 'item', itemId: item.id, variant })
              }}
            >
              <div className="grow">
                <div className="title" style={{ whiteSpace: 'normal' }}>
                  {comparing || merging ? (isSel ? '☑️ ' : '⬜ ') : ''}
                  {item.name}
                  {label && <span className="muted small"> ({label})</span>}
                  {(() => {
                    const fi = flyerInfo(recs[0])
                    return fi && (
                      <span className={'badge ' + (fi.valid ? 'lvl-first' : 'lvl-ok')} style={{ marginLeft: 6, fontSize: 11, verticalAlign: 'middle' }}>
                        {fi.text}
                      </span>
                    )
                  })()}
                </div>
                <div className="sub">
                  {recs.length} record{recs.length === 1 ? '' : 's'}
                  {cheapest ? ` · cheapest at ${cheapest.store.name}` : ''}
                </div>
              </div>
              <div className="right">
                <div className="title" style={{ fontSize: 15, color: 'var(--accent)' }}>
                  {best != null
                    ? fmtDisplay(best, item.kind, db.displayWeightUnit)
                    : recs[0] ? `${fmtMoney(effectivePrice(db, recs[0]))} / ${fmtQty(recs[0].qty, recs[0].unit)}` : '—'}
                </div>
                <div className="sub">{best != null ? 'best' : recs.length ? 'by piece' : 'best'}</div>
              </div>
              {!comparing && !merging && (
                <span
                  role="button"
                  aria-label={`Add price for ${item.name}`}
                  className="row-add"
                  onClick={(e) => {
                    e.stopPropagation()
                    startAdd({ itemId: item.id })
                  }}
                >
                  +
                </span>
              )}
              {!comparing && !merging && <span className="chev">›</span>}
            </button>
          )
        })}
      </div>
      )}

      {pendingAdd && (
        <div className="modal-backdrop" onClick={() => setPendingAdd(null)}>
          <div className="card" style={{ width: 'min(92vw, 400px)' }} onClick={(e) => e.stopPropagation()}>
            <h2>Where are you? 🛒</h2>
            <div className="list">
              {db.stores.map((s) => (
                <button
                  key={s.id}
                  className="row"
                  onClick={() => {
                    update((d) => { d.currentStoreId = s.id })
                    if (pendingAdd.changeOnly) setPendingAdd(null)
                    else goAdd(pendingAdd, s.id)
                  }}
                >
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: s.color, flexShrink: 0 }} />
                  <div className="grow title">{s.name}</div>
                  <span className="chev">›</span>
                </button>
              ))}
            </div>
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setPendingAdd(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {merging && (
        <div className="compare-tray">
          <div className="small" style={{ marginBottom: 8 }}>
            {mergeItemsSel.length === 0 ? (
              <span className="muted">Nothing selected yet.</span>
            ) : (
              mergeItemsSel.map((i) => (
                <span key={i.id} className="badge lvl-first" style={{ marginRight: 6, marginBottom: 4, display: 'inline-block' }}>
                  {i.name}
                </span>
              ))
            )}
          </div>
          {mergeItemsSel.length >= 2 && !canMerge(mergeItemsSel) && (
            <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
              Can't merge: these aren't the same type (weight with weight).
            </p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={exitMerge}>Cancel</button>
            <button
              className="btn danger"
              disabled={mergeItemsSel.length === 0}
              onClick={() => setConfirmIgnore(true)}
            >
              🚫 Delete & ignore
            </button>
            <button
              className="btn"
              disabled={!canMerge(mergeItemsSel)}
              onClick={() => setMergeName(suggestName(mergeItemsSel, recordCounts))}
            >
              🔗 Merge {mergeItemsSel.length >= 2 ? `(${mergeItemsSel.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {confirmIgnore && (
        <div className="modal-backdrop" onClick={() => setConfirmIgnore(false)}>
          <div className="card" style={{ width: 'min(92vw, 400px)' }} onClick={(e) => e.stopPropagation()}>
            <h2>Delete & ignore 🚫</h2>
            <p className="muted small">
              {mergeItemsSel.map((i) => i.name).join(', ')}
            </p>
            <ul className="muted small" style={{ paddingLeft: 18, margin: '4px 0 12px' }}>
              <li>Deletes {mergeRecs.length} price{mergeRecs.length === 1 ? '' : 's'} — this can't be undone.</li>
              <li>The weekly flyer import will skip this <b>kind</b> of product from now on, any brand.</li>
              <li>Undo the ignore later in Settings.</li>
            </ul>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setConfirmIgnore(false)}>Cancel</button>
              <button className="btn danger" onClick={doIgnore}>Delete & ignore</button>
            </div>
          </div>
        </div>
      )}

      {mergeName != null && (
        <div className="modal-backdrop" onClick={() => setMergeName(null)}>
          <div className="card" style={{ width: 'min(92vw, 400px)' }} onClick={(e) => e.stopPropagation()}>
            <h2>Merge into one product 🔗</h2>
            <p className="muted small" style={{ marginTop: -6 }}>
              {mergeItemsSel.map((i) => i.name).join(' + ')}
            </p>
            <label className="field">
              <span className="lbl">Final name</span>
              <input
                type="text"
                value={mergeName}
                autoFocus
                onChange={(e) => setMergeName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doMerge()}
              />
            </label>
            <ul className="muted small" style={{ paddingLeft: 18, margin: '4px 0 12px' }}>
              <li>{mergeRecs.length} price{mergeRecs.length === 1 ? '' : 's'} kept, with their history.</li>
              {(() => {
                const t = targetUnit(mergeItemsSel, mergeRecs)
                return t && <li>Prices converted to a single unit: <b>{t}</b>.</li>
              })()}
              {mergeItemsSel.some((i) => i.category === 'meat') && !mergeItemsSel.every((i) => i.category === 'meat') && (
                <li>Kept as <b>meat</b> (fresh/frozen, bones and skin stay per price).</li>
              )}
            </ul>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setMergeName(null)}>Cancel</button>
              <button className="btn" disabled={!mergeName.trim()} onClick={doMerge}>Merge</button>
            </div>
          </div>
        </div>
      )}

      {comparing && (
        <div className="compare-tray">
          <div className="small" style={{ marginBottom: 8 }}>
            {selectedRows.length === 0 ? (
              <span className="muted">Nothing selected yet.</span>
            ) : (
              selectedRows.map((r) => (
                <span key={r.key} className="badge lvl-first" style={{ marginRight: 6, marginBottom: 4, display: 'inline-block' }}>
                  {r.item.name}{r.label ? ` (${r.label})` : ''} ✕
                </span>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={exitCompare}>Cancel</button>
            <button className="btn" disabled={selectedRows.length < 2} onClick={() => setReport(true)}>
              Compare {selectedRows.length >= 2 ? `(${selectedRows.length})` : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Ranked comparison using each store's LATEST price per product (never old prices).
function CompareReport({ db, rows, onBack, onDone }) {
  const kind = rows[0].item.kind
  const wu = db.displayWeightUnit
  const fmt = (n) => fmtDisplay(n, kind, wu)

  // entries[i]: row + its latest price per store (pricesByStore = latest per store)
  const entries = rows.map((row) => ({
    row,
    stores: pricesByStore(db, row.item.id, row.variant),
  }))

  // Scenario "best mix": each product at its cheapest current store
  const bestMix = entries
    .map((e) => ({ ...e, pick: e.stores[0] }))
    .sort((a, b) => a.pick.norm - b.pick.norm)
  const winner = bestMix[0]

  // Per-store scenarios: only stores carrying 2+ of the compared products
  const storeScenarios = db.stores
    .map((store) => ({
      store,
      list: entries
        .map((e) => ({ row: e.row, at: e.stores.find((s) => s.store.id === store.id) }))
        .filter((e) => e.at)
        .sort((a, b) => a.at.norm - b.at.norm),
    }))
    .filter((s) => s.list.length >= 2)

  const name = (row) => `${row.item.name}${row.label ? ` (${row.label})` : ''}`

  return (
    <div className="screen">
      <div className="topbar">
        <button className="back" onClick={onBack}>‹</button>
        <h1>Cost-effectiveness ⚖️</h1>
      </div>

      <div className="verdict best" style={{ textAlign: 'left' }}>
        <div className="big" style={{ fontSize: 20 }}>🏆 {name(winner.row)}</div>
        <div className="why">
          Most cost-effective right now: {fmt(winner.pick.norm)} at {winner.pick.store.name}.
        </div>
      </div>

      <div className="card">
        <h2>Best mix (cheapest store for each)</h2>
        <p className="muted small" style={{ marginTop: -6, marginBottom: 6 }}>
          Latest price at each product's cheapest store.
        </p>
        <div className="list">
          {bestMix.map(({ row, pick }, i) => (
            <div key={row.key} className="row" style={{ cursor: 'default' }}>
              <div className="grow">
                <div className="title" style={{ whiteSpace: 'normal', fontSize: 15 }}>
                  {i === 0 ? '🏆 ' : `${i + 1}. `}{name(row)}
                </div>
                <div className="sub">
                  {pick.store.name} · {fmtQty(pick.rec.qty, pick.rec.unit)} for {fmtMoney(effectivePrice(db, pick.rec))} · {new Date(pick.rec.ts).toLocaleDateString()}
                </div>
              </div>
              <div className="right">
                <div className="title" style={{ fontSize: 15 }}>{fmt(pick.norm)}</div>
                {i > 0 && (
                  <div className="sub" style={{ color: 'var(--red)' }}>
                    +{Math.round((pick.norm / winner.pick.norm - 1) * 100)}%
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {storeScenarios.map(({ store, list }) => (
        <div className="card" key={store.id}>
          <h2>If you shop at {store.name}</h2>
          <div className="list">
            {list.map(({ row, at }, i) => (
              <div key={row.key} className="row" style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="title" style={{ whiteSpace: 'normal', fontSize: 15 }}>
                    {i === 0 ? '🏆 ' : `${i + 1}. `}{name(row)}
                  </div>
                  <div className="sub">
                    {fmtQty(at.rec.qty, at.rec.unit)} for {fmtMoney(effectivePrice(db, at.rec))} · {new Date(at.rec.ts).toLocaleDateString()}
                  </div>
                </div>
                <div className="right">
                  <div className="title" style={{ fontSize: 15 }}>{fmt(at.norm)}</div>
                  {i > 0 && (
                    <div className="sub" style={{ color: 'var(--red)' }}>
                      +{Math.round((at.norm / list[0].at.norm - 1) * 100)}%
                    </div>
                  )}
                </div>
              </div>
            ))}
            {rows.length > list.length && (
              <p className="muted small" style={{ padding: '8px 2px' }}>
                No price yet at {store.name} for: {rows.filter((r) => !list.some((l) => l.row.key === r.key)).map(name).join(', ')}
              </p>
            )}
          </div>
        </div>
      ))}

      <button className="btn" onClick={onDone}>Done</button>
    </div>
  )
}
