import { useMemo, useState } from 'react'
import {
  itemRecords, recordNorm, verdict, pricesByStore, itemAnnualQty, yearlySavings,
  variantKey, variantLabel, flyerInfo, isComparable,
} from '../lib/analysis'
import { fmtMoney, fmtDisplay, fmtQty, fmtAnnual, annualSliderRange, displayUnitLabel } from '../lib/units'
import { effectivePrice } from '../lib/cashback'
import { addToRvList } from '../lib/rvlist'
import { toast } from '../lib/toast'
import MonthlyChart from '../components/MonthlyChart'
import UnitToggle from '../components/UnitToggle'
import PhotoLink from '../components/PhotoLink'
import FlyerLink from '../components/FlyerLink'

export default function ItemDetail({ db, update, push, pop, view }) {
  const item = db.items.find((i) => i.id === view.itemId)
  const [pickedVariant, setPickedVariant] = useState(view.variant ?? null)
  const [compareSel, setCompareSel] = useState([])
  const [rvState, setRvState] = useState({})
  // History controls: cheapest-first by default so the best deals pop and
  // expired flyer prices sink; expired rows are dimmed, or hidden entirely.
  const [histSort, setHistSort] = useState('price') // 'price' | 'date'
  const [hideExpired, setHideExpired] = useState(false)
  // Filter the store list + history by brand/store text — one product often
  // holds records from many brands (e.g. several tortilla-chip makers), so
  // "doritos" narrows both boxes to just that name.
  const [q, setQ] = useState('')
  const rvSent = useMemo(
    () => new Set((db.rvSent ?? []).map((s) => `${s.itemId}|${s.recId}`)),
    [db.rvSent],
  )
  // No item for this id (deleted, merged away, or a bad push): show a way back
  // instead of a blank screen — `return null` here renders nothing at all, not
  // even the nav bar, and looks like the app crashed.
  if (!item) {
    return (
      <div className="screen">
        <div className="topbar">
          <button className="icon-btn" aria-label="Back" onClick={pop}>←</button>
          <h1>Product</h1>
        </div>
        <div className="empty">
          <div className="ico">🔍</div>
          This product isn't here anymore.
          <div className="sub small" style={{ marginTop: 8 }}>It may have been merged into another product or deleted.</div>
          <button className="btn" style={{ marginTop: 16 }} onClick={pop}>← Go back</button>
        </div>
      </div>
    )
  }

  const allRecs = itemRecords(db, item.id)

  const variants = [...new Map(allRecs.map((r) => [variantKey(r), r])).entries()]
  const variant = pickedVariant ?? (allRecs[0] ? variantKey(allRecs[0]) : '')

  const recs = allRecs.filter((r) => variantKey(r) === variant)
  const latest = recs[0]
  const latestCmp = recs.find((r) => isComparable(item, r))
  const byStore = pricesByStore(db, item.id, variant)
  const norms = recs.map((r) => recordNorm(r, item, db)).filter((n) => n != null)
  const best = norms.length ? Math.min(...norms) : null
  const worst = norms.length ? Math.max(...norms) : null

  const v = latest ? verdict(db, latest) : null
  const annual = itemAnnualQty(item)
  const range = annualSliderRange(item.kind)

  const savings = latestCmp && best != null ? yearlySavings(item, recordNorm(latestCmp, item, db), best) : 0
  const spread =
    byStore.length >= 2 ? yearlySavings(item, byStore[byStore.length - 1].norm, byStore[0].norm) : 0

  const picked = byStore.filter((e) => compareSel.includes(e.store.id))
  const pair = picked.length === 2 ? [...picked].sort((a, b) => a.norm - b.norm) : null
  const pairSavings = pair ? yearlySavings(item, pair[1].norm, pair[0].norm) : 0

  const wu = db.displayWeightUnit ?? 'lb'
  const fmt = (n) => fmtDisplay(n, item.kind, wu)

  const qn = q.trim().toLowerCase()
  const matchRec = (rec) => {
    if (!qn) return true
    const store = db.stores.find((s) => s.id === rec.storeId)
    return (rec.origName ?? '').toLowerCase().includes(qn) || (store?.name ?? '').toLowerCase().includes(qn)
  }
  const byStoreShown = byStore.filter((e) => matchRec(e.rec))

  const now = Date.now()
  const isExpired = (r) => r.validUntil != null && r.validUntil < now
  const histRecs = (hideExpired ? recs.filter((r) => !isExpired(r)) : [...recs]).filter(matchRec)
  if (histSort === 'price') {
    histRecs.sort((a, b) => {
      const na = recordNorm(a, item, db)
      const nb = recordNorm(b, item, db)
      if (na == null && nb == null) return b.ts - a.ts
      if (na == null) return 1 // reference-only prices at the bottom
      if (nb == null) return -1
      return na - nb
    })
  }

  function toggleCompare(storeId) {
    setCompareSel((sel) =>
      sel.includes(storeId) ? sel.filter((s) => s !== storeId) : [...sel.slice(-1), storeId],
    )
  }

  function deleteRecord(rec) {
    update((d) => {
      d.records = d.records.filter((r) => r.id !== rec.id)
    })
    toast('Price deleted', {
      undo: () =>
        update((d) => {
          d.records.push(structuredClone(rec))
        }),
    })
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
      setRvState((s) => ({ ...s, [store.id]: undefined }))
      update((next) => {
        const nowTs = Date.now()
        next.rvSent = (next.rvSent ?? []).filter((s) => {
          const r = next.records.find((r) => r.id === s.recId)
          return r && (r.validUntil == null || r.validUntil >= nowTs)
        })
        next.rvSent.push({ itemId: item.id, recId: rec.id, ts: nowTs })
      })
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ whiteSpace: 'normal' }}>
            {item.name}
            {(() => {
              const fi = flyerInfo(latest)
              return fi && (
                <FlyerLink fi={fi} className={'badge ' + (fi.valid ? 'lvl-first' : 'lvl-ok')} style={{ marginLeft: 8, fontSize: 11, verticalAlign: 'middle' }} />
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

      {byStore.length > 1 && (
        <div className="searchbar" style={{ marginBottom: 14 }}>
          <input
            type="search"
            placeholder="Filter by brand or store…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}

      <div className="detail-grid">
        <div>
          {byStore.length > 0 && (
            <div className="card">
              <h2>Where it's cheapest</h2>
              {byStore.length > 1 && (
                <p className="muted small" style={{ marginTop: -6, marginBottom: 6 }}>
                  Tap two prices to compare their yearly impact.
                </p>
              )}
              <div className="list">
                {byStoreShown.length === 0 && <p className="muted small">No prices match “{q.trim()}”.</p>}
                {byStoreShown.map(({ store, rec, norm }) => {
                  const selected = compareSel.includes(store.id)
                  const sent = rvState[store.id] ?? (rvSent.has(`${item.id}|${rec.id}`) ? 'ok' : undefined)
                  return (
                    <button
                      key={store.id}
                      className={`row${selected ? ' sel' : ''}`}
                      onClick={() => byStore.length > 1 && toggleCompare(store.id)}
                    >
                      <div className="grow">
                        <div className="title">
                          {selected ? '☑️ ' : rec.id === byStore[0].rec.id && byStore.length > 1 ? '🏆 ' : ''}{store.name}
                        </div>
                        {rec.origName && <div className="sub" style={{ fontStyle: 'italic' }}>“{rec.origName}”</div>}
                        <div className="sub">{fmtQty(rec.qty, rec.unit)} for {fmtMoney(effectivePrice(db, rec))}{rec.minQty >= 2 ? ` · 🛒 buy ${rec.minQty}+` : ''} · {new Date(rec.ts).toLocaleDateString()}{flyerInfo(rec) ? <> · <FlyerLink fi={flyerInfo(rec)} /></> : ''}</div>
                      </div>
                      <div className="right title">{fmt(norm)}</div>
                      <span
                        role="button"
                        aria-label="Add to RV Groceries list"
                        className={`rv-add${sent ? ' on' : ''}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!sent) sendToRv(store, rec, norm)
                        }}
                      >
                        {{ pending: '…', ok: '✓', err: '!' }[sent] ?? '+'}
                      </span>
                      <span
                        role="button"
                        aria-label="Delete this price"
                        className="icon-btn"
                        style={{ width: 32, height: 32, fontSize: 15 }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteRecord(rec)
                        }}
                      >
                        ✕
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
        </div>

        <div>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, flex: 1 }}>History</h2>
              <div className="seg" style={{ flexWrap: 'nowrap' }}>
                <button
                  type="button"
                  className={histSort === 'price' ? 'on' : ''}
                  style={{ flex: 'none', padding: '6px 12px', fontSize: 12.5 }}
                  onClick={() => setHistSort('price')}
                >
                  $ Price
                </button>
                <button
                  type="button"
                  className={histSort === 'date' ? 'on' : ''}
                  style={{ flex: 'none', padding: '6px 12px', fontSize: 12.5 }}
                  onClick={() => setHistSort('date')}
                >
                  🕒 Date
                </button>
              </div>
              {recs.some(isExpired) && (
                <button
                  type="button"
                  className={`btn small ${hideExpired ? 'tonal' : 'ghost'}`}
                  onClick={() => setHideExpired(!hideExpired)}
                >
                  {hideExpired ? 'Show expired' : 'Hide expired'}
                </button>
              )}
            </div>
            {histRecs.length === 0 && <p className="muted small">No prices logged yet.</p>}
            <div className="list">
              {histRecs.map((r) => {
                const store = db.stores.find((s) => s.id === r.storeId)
                const norm = recordNorm(r, item, db)
                const pct = norm != null && worst && worst > 0 ? norm / worst : 1
                const cls = best != null && norm <= best * 1.02 ? '' : norm >= worst * 0.98 && recs.length > 1 ? 'worst' : 'mid'
                const expired = isExpired(r)
                return (
                  <div key={r.id} className={`row${expired ? ' expired-rec' : ''}`} style={{ cursor: 'default' }}>
                    <button
                      className="grow"
                      style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', minWidth: 0 }}
                      onClick={() => push({ name: 'addPrice', storeId: r.storeId, presetItemId: item.id, editRecordId: r.id })}
                      aria-label="Edit record"
                    >
                      <div className="title small" style={{ fontSize: 14 }}>
                        {store?.name ?? '?'} · {fmtQty(r.qty, r.unit)}{r.minQty >= 2 ? ` · 🛒 buy ${r.minQty}+` : ''} ✏️
                      </div>
                      {r.origName && <div className="sub" style={{ fontStyle: 'italic' }}>“{r.origName}”</div>}
                      <div className="sub">{new Date(r.ts).toLocaleDateString()}{flyerInfo(r) ? <> · <FlyerLink fi={flyerInfo(r)} /></> : ''}</div>
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
                      className="icon-btn"
                      style={{ width: 32, height: 32, fontSize: 15 }}
                      onClick={() => deleteRecord(r)}
                      aria-label="Delete record"
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
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
