import { useMemo, useRef, useState } from 'react'
import { fmtDisplay } from '../lib/units'
import { meatDeals, groceryDeals, MEAT_TYPES, MEAT_TYPE_LABEL, GROCERY_TYPES, GROCERY_TYPE_LABEL, PROCESSING_LABEL, RATING } from '../lib/meat'
import { ignoreItems } from '../lib/ignore'
import { addToRvList } from '../lib/rvlist'
import { storeLogo } from '../lib/logos'
import PhotoLink from '../components/PhotoLink'
import CompareReport from '../components/CompareReport'
import Chips from '../components/Chips'

// Color a flyer's "until <date>" by how close it is to expiring.
const UNTIL_COLOR = { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--accent)' }
function untilUrgency(ts) {
  const daysLeft = (ts - Date.now()) / 86400000
  if (daysLeft <= 1) return 'red'
  if (daysLeft <= 3) return 'amber'
  return 'green'
}

// Home = current deals. 🥩 Meat mode groups Beef/Pork/Chicken/Fish; ultra-
// processed items get their own "<Type> · ultra-processed" section after the
// natural one, with rating/type/processing filters (rating default:
// excellent + good). 🛒 Groceries mode is one flat list of non-meat deals
// with category (supermarket section) + store filters and $/A–Z sort.
// Expired flyer prices never show.
// Two multi-select modes: ⚖️ Compare button (same-kind only) vs hold-to-
// select any row (🚫 Don't import — delete & ignore, no kind restriction).
// Store picking lives in the Location tab.
const RATING_KEYS = Object.keys(RATING)

export default function Home({ db, update, push }) {
  const groups = useMemo(() => meatDeals(db), [db])
  const grocery = useMemo(() => groceryDeals(db), [db])
  // '🥩 meat' (classified deals) vs '🛒 grocery' (everything else; no meat-type,
  // rating or processing filters — non-meat items have no market data).
  const [mode, setMode] = useState('meat')
  const meat = mode === 'meat'
  const [ratingsOn, setRatingsOn] = useState(() => new Set(['excellent', 'good']))
  const [storesOff, setStoresOff] = useState(() => new Set())
  const [typesOff, setTypesOff] = useState(() => new Set())
  const [catsOff, setCatsOff] = useState(() => new Set()) // grocery category filter
  const [proc, setProc] = useState('all') // cycles all -> natural -> ultra
  const [sort, setSort] = useState('price') // 'price' | 'deal' | 'name'
  // Two separate multi-select modes (same split as the Items tab):
  // - "comparing": explicit ⚖️ Compare button, same-kind only, tray runs the report.
  // - "selecting": hold a row, any kind, tray only offers 🚫 Don't import (ignore).
  const [comparing, setComparing] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState([]) // item ids
  const [report, setReport] = useState(false)
  const [confirmIgnore, setConfirmIgnore] = useState(false)
  const press = useRef({ timer: null, long: false })
  // Transient state of the "＋ send to RV Groceries" button ('pending'/'err').
  // A successful send is persisted in db.rvSent keyed by (item, record), so
  // the ✓ survives reloads and stays until a new record becomes the deal.
  // One-way only: checking/removing the item in the RV app never syncs back.
  const [rvState, setRvState] = useState({})
  const rvSent = useMemo(
    () => new Set((db.rvSent ?? []).map((s) => `${s.itemId}|${s.recId}`)),
    [db.rvSent],
  )

  async function sendToRv(d) {
    setRvState((s) => ({ ...s, [d.key]: 'pending' }))
    try {
      await addToRvList({
        storeName: d.store.name,
        itemName: d.item.name,
        priceLabel: fmtDisplay(d.norm, d.byPiece ? 'count' : d.item.kind, db.displayWeightUnit),
        validUntil: d.rec.validUntil ?? undefined,
      })
      setRvState((s) => ({ ...s, [d.key]: undefined }))
      update((next) => {
        // Prune markers whose record expired or is gone — their ✓ is moot
        // (the deal left Home), so they'd only accumulate forever.
        const now = Date.now()
        next.rvSent = (next.rvSent ?? []).filter((s) => {
          const rec = next.records.find((r) => r.id === s.recId)
          return rec && (rec.validUntil == null || rec.validUntil >= now)
        })
        next.rvSent.push({ itemId: d.item.id, recId: d.rec.id, ts: now })
      })
      navigator.vibrate?.(15)
    } catch (e) {
      console.error('addToRvList failed', e)
      setRvState((s) => ({ ...s, [d.key]: 'err' }))
      setTimeout(() => setRvState((s) => ({ ...s, [d.key]: undefined })), 2500)
    }
  }

  const allDeals = meat ? MEAT_TYPES.flatMap((t) => groups[t] ?? []) : grocery

  const dealStores = useMemo(() => {
    const map = new Map()
    for (const d of allDeals) map.set(d.store.id, d.store)
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [groups, grocery, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (set, setSet, key) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSet(next)
  }

  // Items with no market data (rating null) always pass the rating filter.
  // Grocery mode filters by store and category (no rating/processing there).
  const show = (d) =>
    !storesOff.has(d.store.id) &&
    (meat
      ? (proc === 'all' || (proc === 'ultra') === d.ultra) &&
        (d.rating == null || ratingsOn.has(d.rating))
      : !catsOff.has(d.gtype))

  // Category chips only for sections that currently have grocery deals.
  const groceryCats = meat ? [] : GROCERY_TYPES.filter((t) => grocery.some((d) => d.gtype === t))

  // 'deal' = biggest discount vs the item's market avg price; no-market last.
  const dealScore = (d) => (d.item.market ? d.norm / d.item.market.avg : Infinity)
  const cmp = {
    price: (a, b) => a.norm - b.norm,
    deal: (a, b) => dealScore(a) - dealScore(b),
    name: (a, b) => a.item.name.localeCompare(b.item.name),
  }[sort]

  // One section per meat type for natural items, followed by a separate
  // "<Type> · ultra-processed" section when the type has ultra items.
  // Grocery mode is one flat, unlabeled section.
  const sections = meat
    ? MEAT_TYPES.flatMap((t) => {
        if (typesOff.has(t)) return []
        const list = (groups[t] ?? []).filter(show).sort(cmp)
        const natural = list.filter((d) => !d.ultra)
        const ultra = list.filter((d) => d.ultra)
        const out = []
        if (natural.length) out.push({ key: t, label: MEAT_TYPE_LABEL[t], list: natural })
        if (ultra.length) out.push({ key: `${t}-ultra`, label: `${MEAT_TYPE_LABEL[t]} · ultra-processed`, list: ultra })
        return out
      })
    : (() => {
        const list = grocery.filter(show).sort(cmp)
        return list.length ? [{ key: 'grocery', label: null, list }] : []
      })()

  // Selection is per item; an item can have two rows (normal + by-piece),
  // so dedupe by item id — trays and CompareReport want one entry per item.
  const selectedDeals = []
  {
    const seen = new Set()
    for (const d of allDeals) {
      if (selected.includes(d.item.id) && !seen.has(d.item.id)) {
        seen.add(d.item.id)
        selectedDeals.push(d)
      }
    }
  }
  const compareKind = selectedDeals[0]?.item.kind ?? null
  // CompareReport rows: variant null = compare across all the item's records
  const compareRows = selectedDeals.map((d) => ({ item: d.item, variant: null, label: '', key: d.item.id }))

  function holdStart(d) {
    if (comparing || selecting) return
    press.current.long = false
    press.current.timer = setTimeout(() => {
      press.current.long = true
      setSelecting(true)
      setSelected([d.item.id])
      navigator.vibrate?.(20)
    }, 450)
  }

  function holdEnd() {
    clearTimeout(press.current.timer)
  }

  function toggleSelect(d) {
    setSelected((sel) =>
      sel.includes(d.item.id) ? sel.filter((id) => id !== d.item.id) : [...sel, d.item.id],
    )
  }

  function exitCompare() {
    setComparing(false)
    setSelected([])
    setReport(false)
  }

  function exitSelect() {
    setSelecting(false)
    setSelected([])
    setConfirmIgnore(false)
  }

  // "Don't import anymore": same delete-&-ignore as the Items tab — removes
  // the items and their prices, and the flyer import skips that product type.
  function doIgnore() {
    const ids = selected
    update((d) => ignoreItems(d, ids))
    exitSelect()
  }

  function switchMode(m) {
    setMode(m)
    if (m !== 'meat' && sort === 'deal') setSort('price') // no market data → no 🔥 sort
  }

  if (report && compareRows.length >= 2) {
    return (
      <CompareReport
        db={db}
        rows={compareRows}
        onBack={() => setReport(false)}
        onDone={exitCompare}
      />
    )
  }

  return (
    <div className="screen" style={comparing || selecting ? { paddingBottom: 170 } : undefined}>
      <div className="topbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1>{comparing ? 'Pick items ⚖️' : selecting ? 'Selected items' : meat ? '🥩 Meat deals' : '🛒 Grocery deals'}</h1>
        {!comparing && !selecting && (
          <div style={{ display: 'flex', gap: 6 }}>
            {meat && (
              <button
                className="btn small ghost"
                onClick={() => setProc(proc === 'all' ? 'natural' : proc === 'natural' ? 'ultra' : 'all')}
              >
                {proc === 'all' ? 'All' : PROCESSING_LABEL[proc]}
              </button>
            )}
            {allDeals.length >= 2 && (
              <button className="btn small ghost" onClick={() => setComparing(true)}>⚖️ Compare</button>
            )}
          </div>
        )}
      </div>

      {comparing && (
        <p className="muted small" style={{ marginTop: -8, marginBottom: 10 }}>
          Tap the deals you want to compare — only same-type items (weight with weight).
        </p>
      )}

      {selecting && (
        <p className="muted small" style={{ marginTop: -8, marginBottom: 10 }}>
          Tap more deals to select them, then 🚫 Don't import.
        </p>
      )}

      {!comparing && !selecting && (
        <Chips style={{ marginBottom: 8 }}>
          <button className={meat ? 'on' : ''} onClick={() => switchMode('meat')}>🥩 Meat</button>
          <button className={meat ? '' : 'on'} onClick={() => switchMode('grocery')}>🛒 Groceries</button>
        </Chips>
      )}

      {meat && (
        <Chips style={{ marginBottom: 8 }}>
          {RATING_KEYS.map((r) => (
            <button
              key={r}
              className={ratingsOn.has(r) ? 'on' : ''}
              onClick={() => toggle(ratingsOn, setRatingsOn, r)}
            >
              {RATING[r].label.replace(' deal', '')}
            </button>
          ))}
        </Chips>
      )}
      {meat && (
        <Chips style={{ marginBottom: 8 }}>
          <button
            aria-label="Clear meat type selection"
            onClick={() => setTypesOff(new Set(MEAT_TYPES))}
          >
            ✕
          </button>
          <button
            aria-label="Select all meat types"
            onClick={() => setTypesOff(new Set())}
          >
            All
          </button>
          {MEAT_TYPES.filter((t) => groups[t]?.length).map((t) => (
            <button
              key={t}
              className={typesOff.has(t) ? '' : 'on'}
              onClick={() => toggle(typesOff, setTypesOff, t)}
            >
              {MEAT_TYPE_LABEL[t]}
            </button>
          ))}
        </Chips>
      )}
      {!meat && groceryCats.length > 1 && (
        <Chips style={{ marginBottom: 8 }}>
          <button
            aria-label="Clear category selection"
            onClick={() => setCatsOff(new Set(GROCERY_TYPES))}
          >
            ✕
          </button>
          <button
            aria-label="Select all categories"
            onClick={() => setCatsOff(new Set())}
          >
            All
          </button>
          {groceryCats.map((t) => (
            <button
              key={t}
              className={catsOff.has(t) ? '' : 'on'}
              onClick={() => toggle(catsOff, setCatsOff, t)}
            >
              {GROCERY_TYPE_LABEL[t]}
            </button>
          ))}
        </Chips>
      )}
      {dealStores.length > 1 && (
        <Chips style={{ marginBottom: 8 }}>
          <button
            aria-label="Clear store selection"
            onClick={() => setStoresOff(new Set(dealStores.map((s) => s.id)))}
          >
            ✕
          </button>
          <button
            aria-label="Select all stores"
            onClick={() => setStoresOff(new Set())}
          >
            All
          </button>
          {dealStores.map((s) => (
            <button
              key={s.id}
              className={storesOff.has(s.id) ? '' : 'on'}
              onClick={() => toggle(storesOff, setStoresOff, s.id)}
            >
              {s.name}
            </button>
          ))}
        </Chips>
      )}

      <Chips style={{ marginBottom: 8 }}>
        <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--muted)', flex: '0 0 auto' }}>Sort</span>
        {[['price', '$ Cheapest'], ...(meat ? [['deal', '🔥 Best deal']] : []), ['name', 'A–Z']].map(([k, label]) => (
          <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
            {label}
          </button>
        ))}
      </Chips>

      {sections.length === 0 && (
        <div className="empty" style={{ padding: 32 }}>
          No {meat ? 'meat' : 'grocery'} deals match the filters.
          <div className="sub" style={{ marginTop: 6 }}>
            {meat
              ? 'Deals appear here after the weekly flyer import finds prices below the usual Toronto market price.'
              : 'Non-meat products with a current price show up here after the weekly flyer import (or a manual entry).'}
          </div>
        </div>
      )}

      {sections.map(({ key, label, list }) => (
        <div key={key} style={{ marginTop: 10 }}>
          {label && <div className="lbl" style={{ marginBottom: 4 }}>{label}</div>}
          <div className="card list" style={{ padding: '2px 14px' }}>
            {list.map((d) => {
              const isSel = selected.includes(d.item.id)
              // Kind restriction only applies to ⚖️ Compare (same-kind report);
              // hold-to-select for ignoring has no such constraint. By-piece
              // rows have no comparable price, so Compare never accepts them.
              const disabled = comparing &&
                (d.byPiece || (compareKind && d.item.kind !== compareKind && !isSel))
              return (
              <button
                key={d.key}
                className="row"
                style={{
                  ...(isSel ? { background: 'var(--accent-soft)', borderRadius: 10, padding: '13px 8px' } : null),
                  ...(disabled ? { opacity: 0.35 } : null),
                }}
                onPointerDown={() => holdStart(d)}
                onPointerUp={holdEnd}
                onPointerLeave={holdEnd}
                onPointerCancel={holdEnd}
                onContextMenu={(e) => e.preventDefault()}
                onClick={() => {
                  if (press.current.long) { press.current.long = false; return }
                  if (comparing) return !disabled && toggleSelect(d)
                  if (selecting) return toggleSelect(d)
                  push({ name: 'item', itemId: d.item.id })
                }}
              >
                <div className="grow">
                  <div className="title">
                    {(comparing || selecting) ? (isSel ? '☑️ ' : '⬜ ') : ''}
                    {d.item.name}
                    {!comparing && !selecting && <PhotoLink name={d.item.name} />}
                  </div>
                  <div className="sub row-store">
                    {storeLogo(d.store.name) ? (
                      <img className="row-logo" src={storeLogo(d.store.name)} alt={d.store.name} title={d.store.name} />
                    ) : (
                      <span>{d.store.name}</span>
                    )}
                    {d.rec.validUntil && (
                      <span style={{ color: UNTIL_COLOR[untilUrgency(d.rec.validUntil)] }}>
                        until {new Date(d.rec.validUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="right">
                  <div className="title">{fmtDisplay(d.norm, d.byPiece ? 'count' : d.item.kind, db.displayWeightUnit)}</div>
                  {d.byPiece && <span className="badge lvl-ok">📦 by piece</span>}
                  {d.rating && <span className={`badge ${RATING[d.rating].cls}`}>{RATING[d.rating].label}</span>}
                </div>
                {/* Send the deal to the RV Groceries shopping list (rvlist.js).
                    span, not button: rows are already buttons. */}
                {!comparing && !selecting && (() => {
                  const st = rvState[d.key] ??
                    (rvSent.has(`${d.item.id}|${d.rec.id}`) ? 'ok' : undefined)
                  return (
                    <span
                      role="button"
                      aria-label="Add to RV Groceries list"
                      className={`rv-add${st ? ' on' : ''}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!st) sendToRv(d)
                      }}
                    >
                      {{ pending: '…', ok: '✓', err: '!' }[st] ?? '+'}
                    </span>
                  )
                })()}
              </button>
              )
            })}
          </div>
        </div>
      ))}

      {comparing && (
        <div className="compare-tray">
          <div className="small" style={{ marginBottom: 8 }}>
            {selectedDeals.length === 0 ? (
              <span className="muted">Nothing selected yet.</span>
            ) : (
              selectedDeals.map((d) => (
                <span key={d.item.id} className="badge lvl-first" style={{ marginRight: 6, marginBottom: 4, display: 'inline-block' }}>
                  {d.item.name}
                </span>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={exitCompare}>Cancel</button>
            <button className="btn" disabled={selectedDeals.length < 2} onClick={() => setReport(true)}>
              Compare {selectedDeals.length >= 2 ? `(${selectedDeals.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {selecting && (
        <div className="compare-tray">
          <div className="small" style={{ marginBottom: 8 }}>
            {selectedDeals.length === 0 ? (
              <span className="muted">Nothing selected yet.</span>
            ) : (
              selectedDeals.map((d) => (
                <span key={d.item.id} className="badge lvl-first" style={{ marginRight: 6, marginBottom: 4, display: 'inline-block' }}>
                  {d.item.name}
                </span>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={exitSelect}>Cancel</button>
            <button
              className="btn danger"
              disabled={selectedDeals.length === 0}
              onClick={() => setConfirmIgnore(true)}
            >
              🚫 Don't import {selectedDeals.length >= 2 ? `(${selectedDeals.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {confirmIgnore && (
        <div className="modal-backdrop" onClick={() => setConfirmIgnore(false)}>
          <div className="card" style={{ width: 'min(92vw, 400px)' }} onClick={(e) => e.stopPropagation()}>
            <h2>Don't import anymore 🚫</h2>
            <p className="muted small">
              {selectedDeals.map((d) => d.item.name).join(', ')}
            </p>
            <ul className="muted small" style={{ paddingLeft: 18, margin: '4px 0 12px' }}>
              <li>Removes the product{selected.length === 1 ? '' : 's'} and all saved prices — this can't be undone.</li>
              <li>The weekly flyer import will skip this <b>kind</b> of product from now on, any brand.</li>
              <li>Undo the ignore later in Settings.</li>
            </ul>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setConfirmIgnore(false)}>Cancel</button>
              <button className="btn danger" onClick={doIgnore}>Don't import</button>
            </div>
          </div>
        </div>
      )}

      <div className="small muted" style={{ textAlign: 'center', marginTop: 16, opacity: 0.6 }}>
        Released {new Date(__BUILD_DATE__).toLocaleString()}
      </div>
    </div>
  )
}
