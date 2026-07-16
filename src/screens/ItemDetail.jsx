import { useState } from 'react'
import {
  itemRecords, recordNorm, verdict, pricesByStore, itemAnnualQty, yearlySavings,
  variantKey, variantLabel, flyerInfo, isComparable,
} from '../lib/analysis'
import { fmtMoney, fmtDisplay, fmtQty, fmtAnnual, annualSliderRange, displayUnitLabel } from '../lib/units'
import { effectivePrice } from '../lib/cashback'
import { addToRvList } from '../lib/rvlist'
import MonthlyChart from '../components/MonthlyChart'
import UnitToggle from '../components/UnitToggle'
import PhotoLink from '../components/PhotoLink'

export default function ItemDetail({ db, update, push, pop, view }) {
  const item = db.items.find((i) => i.id === view.itemId)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [pickedVariant, setPickedVariant] = useState(view.variant ?? null)
  const [compareSel, setCompareSel] = useState([])
  const [rvState, setRvState] = useState({})
  if (!item) return null

  const allRecs = itemRecords(db, item.id)

  // Meat variations (bones × skin) are separate products: pick one to view.
  const variants = [...new Map(allRecs.map((r) => [variantKey(r), r])).entries()]
  const variant = pickedVariant ?? (allRecs[0] ? variantKey(allRecs[0]) : '')

  const recs = allRecs.filter((r) => variantKey(r) === variant)
  const latest = recs[0]
  // Latest comparable price drives the stats; by-piece records are history only.
  const latestCmp = recs.find((r) => isComparable(item, r))
  const byStore = pricesByStore(db, item.id, variant)
  const norms = recs.map((r) => recordNorm(r, item, db)).filter((n) => n != null)
  const best = norms.length ? Math.min(...norms) : null
  const worst = norms.length ? Math.max(...norms) : null

  const v = latest ? verdict(db, latest) : null
  const annual = itemAnnualQty(item)
  const range = annualSliderRange(item.kind)

  // Savings: latest price vs best ever (if latest isn't the best)
  const savings = latestCmp && best != null ? yearlySavings(item, recordNorm(latestCmp, item, db), best) : 0
  // Spread savings: worst store vs best store currently
  const spread =
    byStore.length >= 2 ? yearlySavings(item, byStore[byStore.length - 1].norm, byStore[0].norm) : 0

  // User-picked pair of store prices to compare (falls back to auto pick)
  const picked = byStore.filter((e) => compareSel.includes(e.store.id))
  const pair = picked.length === 2 ? [...picked].sort((a, b) => a.norm - b.norm) : null
  const pairSavings = pair ? yearlySavings(item, pair[1].norm, pair[0].norm) : 0

  const wu = db.displayWeightUnit ?? 'lb'
  const fmt = (n) => fmtDisplay(n, item.kind, wu)

  function toggleCompare(storeId) {
    setCompareSel((sel) =>
      sel.includes(storeId) ? sel.filter((s) => s !== storeId) : [...sel.slice(-1), storeId],
    )
  }

  async function sendToRv(store, rec, norm) {
    setRvState((s) => ({ ...s, [store.id]: 'pending' }))
    try {
      await addToRvList({
        storeName: store.name,
        itemName: item.name,
        priceLabel: fmtDisplay(norm, item.kind, wu),
        validUntil: rec.validUntil ?? undefined,
      })
      setRvState((s) => ({ ...s, [store.id]: 'ok' }))
      navigator.vibrate?.(15)
    } catch (e) {
      console.error('addToRvList failed', e)
      setRvState((s) => ({ ...s, [store.id]: 'err' }))
      setTimeout(() => setRvState((s) => ({ ...s, [store.id]: undefined })), 2500)
    }
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button className="back" onClick={pop}>‹</button>
        <div>
          <h1>
            {item.name}
            {(() => {
              const fi = flyerInfo(latest)
              return fi && (
                <span className={'badge ' + (fi.valid ? 'lvl-first' : 'lvl-ok')} style={{ marginLeft: 8, fontSize: 11, verticalAlign: 'middle' }}>
                  {fi.text}
                </span>
              )
            })()}
          </h1>
          <span className="muted small">
            prices shown per {displayUnitLabel(item.kind, wu)} · <PhotoLink name={item.name} />
          </span>
        </div>
        {item.kind === 'weight' && <UnitToggle db={db} update={update} />}
      </div>

      {variants.length > 1 && (
        <div className="seg" style={{ marginBottom: 14 }}>
          {variants.map(([key, rec]) => (
            <button
              key={key}
              type="button"
              className={variant === key ? 'on' : ''}
              onClick={() => { setPickedVariant(key); setCompareSel([]) }}
            >
              {variantLabel(rec) || 'standard'}
            </button>
          ))}
        </div>
      )}
      {variants.length === 1 && latest && variantLabel(latest) && (
        <p className="muted small" style={{ marginTop: -10, marginBottom: 12 }}>{variantLabel(latest)}</p>
      )}

      {v && view.fromSave && !pickedVariant && <VerdictBanner v={v} fmt={fmt} />}

      {latest && (
        <div className="stat-row">
          <div className="stat">
            <div className="v">{latestCmp ? fmt(recordNorm(latestCmp, item, db)).split(' / ')[0] : '—'}</div>
            <div className="k">Latest</div>
          </div>
          <div className="stat">
            <div className="v" style={{ color: 'var(--accent)' }}>{best != null ? fmt(best).split(' / ')[0] : '—'}</div>
            <div className="k">Best ever</div>
          </div>
          <div className="stat">
            <div className="v">{recs.length}</div>
            <div className="k">Records</div>
          </div>
        </div>
      )}

      {byStore.length > 0 && (
        <div className="card">
          <h2>Where it's cheapest</h2>
          {byStore.length > 1 && (
            <p className="muted small" style={{ marginTop: -6, marginBottom: 6 }}>
              Tap two prices to compare their yearly impact.
            </p>
          )}
          <div className="list">
            {byStore.map(({ store, rec, norm }, idx) => {
              const selected = compareSel.includes(store.id)
              return (
                <button
                  key={store.id}
                  className="row"
                  onClick={() => byStore.length > 1 && toggleCompare(store.id)}
                  style={selected ? { background: 'var(--accent-soft)', borderRadius: 10, padding: '13px 8px' } : undefined}
                >
                  <div className="grow">
                    <div className="title">
                      {selected ? '☑️ ' : idx === 0 && byStore.length > 1 ? '🏆 ' : ''}{store.name}
                    </div>
                    <div className="sub">{fmtQty(rec.qty, rec.unit)} for {fmtMoney(effectivePrice(db, rec))} · {new Date(rec.ts).toLocaleDateString()}{flyerInfo(rec) ? ` · ${flyerInfo(rec).text}` : ''}</div>
                  </div>
                  <div className="right title">{fmt(norm)}</div>
                  <span
                    role="button"
                    aria-label="Add to RV Groceries list"
                    className={`rv-add${rvState[store.id] ? ' on' : ''}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!rvState[store.id]) sendToRv(store, rec, norm)
                    }}
                  >
                    {{ pending: '…', ok: '✓', err: '!' }[rvState[store.id]] ?? '+'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {(pair || savings > 1 || spread > 1) && (
        <div className="card" style={{ textAlign: 'center' }}>
          <h2>Yearly impact 💰</h2>
          <div className="savings-num">{fmtMoney(pair ? pairSavings : Math.max(savings, spread))}</div>
          <p className="muted small" style={{ marginTop: 4 }}>
            {pair
              ? `saved per year buying at ${pair[0].store.name} (${fmt(pair[0].norm)}) instead of ${pair[1].store.name} (${fmt(pair[1].norm)})`
              : savings > spread
              ? 'saved per year buying at the best price you\'ve seen instead of the latest one'
              : `saved per year buying at ${byStore[0].store.name} instead of ${byStore[byStore.length - 1].store.name}`}
          </p>
          <div style={{ marginTop: 16, textAlign: 'left' }}>
            <span className="lbl small muted" style={{ fontWeight: 600 }}>
              Family consumption: <b style={{ color: 'var(--text)' }}>{fmtAnnual(annual, item.kind)} / year</b>
            </span>
            <input
              type="range"
              min={range.min}
              max={range.max}
              step={range.step}
              value={annual}
              onChange={(e) =>
                update((d) => {
                  const it = d.items.find((i) => i.id === item.id)
                  it.annualQty = Number(e.target.value)
                })
              }
            />
          </div>
        </div>
      )}

      <MonthlyChart recs={recs} item={item} kind={item.kind} weightUnit={wu} db={db} />

      <div className="card">
        <h2>History</h2>
        {recs.length === 0 && <p className="muted small">No prices logged yet.</p>}
        <div className="list">
          {recs.map((r) => {
            const store = db.stores.find((s) => s.id === r.storeId)
            const norm = recordNorm(r, item, db)
            const pct = norm != null && worst && worst > 0 ? norm / worst : 1
            const cls = best != null && norm <= best * 1.02 ? '' : norm >= worst * 0.98 && recs.length > 1 ? 'worst' : 'mid'
            return (
              <div key={r.id} className="row" style={{ cursor: 'default' }}>
                <button
                  className="grow"
                  style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
                  onClick={() => push({ name: 'addPrice', storeId: r.storeId, presetItemId: item.id, editRecordId: r.id })}
                  aria-label="Edit record"
                >
                  <div className="title small" style={{ fontSize: 14 }}>
                    {store?.name ?? '?'} · {fmtQty(r.qty, r.unit)} ✏️
                  </div>
                  <div className="sub">{new Date(r.ts).toLocaleDateString()}{flyerInfo(r) ? ` · ${flyerInfo(r).text}` : ''}</div>
                  {norm != null && (
                    <div className={'hist-bar ' + cls} style={{ width: `${Math.max(6, pct * 100)}%`, marginTop: 6 }} />
                  )}
                </button>
                <div className="right">
                  <div className="title" style={{ fontSize: 15 }}>
                    {norm != null ? fmt(norm) : `${fmtMoney(effectivePrice(db, r))} / ${fmtQty(r.qty, r.unit)}`}
                  </div>
                  <div className="sub">{norm != null ? `${fmtMoney(effectivePrice(db, r))} total` : 'no weight — reference only'}</div>
                </div>
                <button
                  className="chev"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6 }}
                  onClick={() => setConfirmDelete(r.id)}
                  aria-label="Delete record"
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {confirmDelete && (
        <div className="card">
          <p style={{ marginBottom: 10 }}>Delete this price record?</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button
              className="btn danger"
              onClick={() => {
                update((d) => {
                  d.records = d.records.filter((r) => r.id !== confirmDelete)
                })
                setConfirmDelete(null)
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function VerdictBanner({ v, fmt }) {
  const texts = {
    first: { big: '✅ First price saved!', why: 'Now you have a baseline — log it at other stores to compare.' },
    best: { big: '🎉 Best price yet!', why: 'This matches or beats the lowest price you\'ve ever recorded.' },
    good: { big: '👍 Good deal', why: `Within 10% of your best price (${fmt(v.best)}).` },
    ok: { big: '😐 Average price', why: `Your best was ${fmt(v.best)}${v.bestStore ? ` at ${v.bestStore.name}` : ''}.` },
    high: { big: '❌ Expensive', why: `You've paid ${fmt(v.best)}${v.bestStore ? ` at ${v.bestStore.name}` : ''} — ${Math.round((v.norm / v.best - 1) * 100)}% cheaper.` },
  }
  const t = texts[v.level]
  return (
    <div className={'verdict ' + v.level}>
      <div className="big">{t.big}</div>
      <div className="why">{t.why}</div>
    </div>
  )
}
