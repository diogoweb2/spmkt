import { useMemo, useRef, useState } from 'react'
import { fmtDisplay, fmtMoney, fmtQty } from '../lib/units'
import { meatDeals, groceryDeals, MEAT_TYPES, MEAT_TYPE_LABEL, GROCERY_TYPES, GROCERY_TYPE_LABEL, PROCESSING_LABEL, RATING } from '../lib/meat'
import { ignoreItems } from '../lib/ignore'
import { canMerge, mergeItems, suggestName, targetUnit, groupIds } from '../lib/merge'
import { itemRecords, recordNorm, pricesByStore, variantKey, variantLabel, flyerInfo, isComparable } from '../lib/analysis'
import { effectivePrice } from '../lib/cashback'
import { addToRvList } from '../lib/rvlist'
import { storeLogo } from '../lib/logos'
import { toast } from '../lib/toast'
import useSessionState from '../lib/useSessionState'
import PhotoLink from '../components/PhotoLink'
import CompareReport from '../components/CompareReport'
import FlyerLink from '../components/FlyerLink'
import Chips from '../components/Chips'
import StoreSheet from '../components/StoreSheet'

// Home is the single browse surface: a 🏷️ Deals / 📋 All items view switch
// (the old Items tab folded in), a 📍 store chip (the old Location tab folded
// into a bottom sheet), and ONE selection mode — long-press a row or use its
// ⋮ menu, then act from the contextual action bar (⚖️ Compare · 🔗 Merge ·
// 🚫 Don't import). See BUSINESS_RULES §9–10.
const RATING_KEYS = Object.keys(RATING)
const UNTIL_COLOR = { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--accent)' }

function untilUrgency(ts) {
  const daysLeft = (ts - Date.now()) / 86400000
  if (daysLeft <= 1) return 'red'
  if (daysLeft <= 3) return 'amber'
  return 'green'
}

// "vs your last buy": compare a deal's price to the item's previous
// comparable record (any store). null when there is no older price or the
// difference is under 3% (noise).
function lastBuyDelta(db, d) {
  if (d.byPiece) return null
  const item = d.item
  const prev = itemRecords(db, item.id).find(
    (r) => r.ts < d.rec.ts && r.id !== d.rec.id && isComparable(item, r) && recordNorm(r, item, db) != null,
  )
  if (!prev) return null
  const prevNorm = recordNorm(prev, item, db)
  const pct = Math.round(((d.norm - prevNorm) / prevNorm) * 100)
  if (Math.abs(pct) < 3) return null
  return pct
}

export default function Home({ db, update, push }) {
  const [view, setView] = useSessionState('home.view', 'deals') // 'deals' | 'items'
  const [showExpired, setShowExpired] = useSessionState('home.showExpired', false)
  const [mode, setMode] = useSessionState('home.mode', 'meat')
  const meat = mode === 'meat'
  const [ratingsOn, setRatingsOn] = useSessionState('home.ratingsOn', () => new Set(['excellent', 'good']), { set: true })
  const [storesOff, setStoresOff] = useSessionState('home.storesOff', () => new Set(), { set: true })
  const [typesOff, setTypesOff] = useSessionState('home.typesOff', () => new Set(), { set: true })
  const [catsOff, setCatsOff] = useSessionState('home.catsOff', () => new Set(), { set: true })
  const [proc, setProc] = useSessionState('home.proc', 'all')
  const [sort, setSort] = useSessionState('home.sort', 'deal')
  const [q, setQ] = useSessionState('home.q', '')

  // ONE selection mode. Keys: item id in Deals view, `${itemId}|${variant}`
  // in All items view (a meat item's variants are separate compare rows).
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState([])
  const [report, setReport] = useState(false)
  const [confirmIgnore, setConfirmIgnore] = useState(null) // array of item ids
  const [mergeName, setMergeName] = useState(null)
  const [menuFor, setMenuFor] = useState(null) // row key with its ⋮ menu open
  const [storeSheet, setStoreSheet] = useState(false)
  const [pendingAdd, setPendingAdd] = useState(null) // add flow waiting for a store pick
  const press = useRef({ timer: null, long: false })

  const groups = useMemo(() => meatDeals(db, { includeExpired: showExpired }), [db, showExpired])
  const grocery = useMemo(() => groceryDeals(db, { includeExpired: showExpired }), [db, showExpired])
  const allDeals = meat ? MEAT_TYPES.flatMap((t) => groups[t] ?? []) : grocery
  const currentStore = db.stores.find((s) => s.id === db.currentStoreId)

  // ---------- RV Groceries send (unchanged behavior) ----------
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

  // ---------- deals filtering ----------
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

  const qNorm = q.trim().toLowerCase()
  const show = (d) =>
    !storesOff.has(d.store.id) &&
    (d.rating == null || ratingsOn.has(d.rating)) &&
    (!qNorm || d.item.name.toLowerCase().includes(qNorm)) &&
    (meat
      ? proc === 'all' || (proc === 'ultra') === d.ultra
      : !catsOff.has(d.gtype))

  const groceryCats = meat ? [] : GROCERY_TYPES.filter((t) => grocery.some((d) => d.gtype === t))

  const dealScore = (d) => (d.item.market ? d.norm / d.item.market.avg : Infinity)
  const cmp = {
    price: (a, b) => a.norm - b.norm,
    deal: (a, b) => dealScore(a) - dealScore(b),
    name: (a, b) => a.item.name.localeCompare(b.item.name),
  }[sort]

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
    : GROCERY_TYPES.flatMap((t) => {
        const list = grocery.filter((d) => d.gtype === t && show(d)).sort(cmp)
        return list.length ? [{ key: t, label: GROCERY_TYPE_LABEL[t], list }] : []
      })

  // ---------- All items rows (the old Items tab, folded in) ----------
  const itemRows = useMemo(() => {
    const query = qNorm
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
  }, [db, qNorm])

  // ---------- selection helpers ----------
  const deals = view === 'deals'

  // Deals view selection is per item (an item's normal + by-piece rows toggle
  // together); All items view is per item+variant row.
  const selectedDeals = useMemo(() => {
    if (!deals) return []
    const seen = new Set()
    const out = []
    for (const d of allDeals) {
      if (selected.includes(d.item.id) && !seen.has(d.item.id)) {
        seen.add(d.item.id)
        out.push(d)
      }
    }
    return out
  }, [deals, selected, allDeals])

  const selectedRows = deals ? [] : itemRows.filter((r) => selected.includes(r.key))

  // The items behind the selection (merge / ignore act per item).
  const selectedItems = deals
    ? selectedDeals.map((d) => d.item)
    : [...new Map(selectedRows.map((r) => [r.item.id, r.item])).values()]
  const selectedIds = selectedItems.map((i) => i.id)
  const mergeRecs = db.records.filter((r) => selectedIds.includes(r.itemId))
  const recordCounts = Object.fromEntries(selectedItems.map((i) => [i.id, itemRecords(db, i.id).length]))

  // Compare needs ≥2 comparable same-kind entries.
  const compareRows = deals
    ? selectedDeals.filter((d) => !d.byPiece).map((d) => ({ item: d.item, variant: null, label: '', key: d.item.id }))
    : selectedRows.filter((r) => r.recs.length && pricesByStore(db, r.item.id, r.variant).length)
  const compareOk =
    compareRows.length >= 2 &&
    compareRows.length === selected.length &&
    compareRows.every((r) => r.item.kind === compareRows[0].item.kind)

  function rowKey(x) {
    return deals ? x.item.id : x.key
  }

  function toggleSelect(x) {
    const key = rowKey(x)
    setSelected((sel) => (sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key]))
  }

  function startSelect(x) {
    setSelecting(true)
    setSelected([rowKey(x)])
    setMenuFor(null)
  }

  function exitSelect() {
    setSelecting(false)
    setSelected([])
    setReport(false)
    setConfirmIgnore(null)
    setMergeName(null)
  }

  function holdStart(x) {
    if (selecting) return
    press.current.long = false
    press.current.timer = setTimeout(() => {
      press.current.long = true
      startSelect(x)
      navigator.vibrate?.(20)
    }, 450)
  }

  function holdEnd() {
    clearTimeout(press.current.timer)
  }

  function doMerge() {
    const name = mergeName.trim()
    if (!name) return
    const ids = selectedIds
    update((d) => mergeItems(d, ids, name))
    exitSelect()
    toast(`Merged into “${name}”`)
  }

  function doIgnore() {
    const ids = confirmIgnore
    const names = db.items.filter((i) => ids.includes(i.id)).map((i) => i.name).join(', ')
    update((d) => ignoreItems(d, ids))
    exitSelect()
    toast(`Won't import anymore: ${names}`)
  }

  // ---------- add-a-price from All items (needs a store) ----------
  function goAdd(target, storeId) {
    setPendingAdd(null)
    push({ name: 'addPrice', storeId, presetItemId: target.itemId, presetQuery: target.query })
  }

  function startAdd(target) {
    if (currentStore) goAdd(target, currentStore.id)
    else setPendingAdd(target)
  }

  if (report && compareRows.length >= 2) {
    return (
      <CompareReport
        db={db}
        rows={compareRows}
        onBack={() => setReport(false)}
        onDone={exitSelect}
      />
    )
  }

  const noExactMatch =
    q.trim() && !db.items.some((i) => i.name.toLowerCase() === q.trim().toLowerCase())

  return (
    <div className="screen" onClick={() => menuFor && setMenuFor(null)}>
      {/* ---------- selection action bar ---------- */}
      {selecting ? (
        <div className="action-bar">
          <button aria-label="Exit selection" onClick={exitSelect}>✕</button>
          <span className="count">{selected.length} selected</span>
          <button disabled={!compareOk} title="Compare prices (same-type products)" onClick={() => setReport(true)}>
            ⚖️ Compare
          </button>
          <button
            disabled={!(selectedItems.length >= 2 && canMerge(selectedItems))}
            title="Merge duplicates into one product"
            onClick={() => setMergeName(suggestName(selectedItems, recordCounts, groupIds(db)))}
          >
            🔗 Merge
          </button>
          <button
            disabled={selectedItems.length === 0}
            title="Delete and never import again"
            onClick={() => setConfirmIgnore(selectedIds)}
          >
            🚫 Don't import
          </button>
        </div>
      ) : (
        <div className="topbar" style={{ justifyContent: 'space-between' }}>
          <h1>Smart Price</h1>
          <button
            className="store-chip"
            title="Change where you are"
            onClick={() => setStoreSheet(true)}
          >
            📍
            {currentStore
              ? storeLogo(currentStore.name)
                ? <img src={storeLogo(currentStore.name)} alt={currentStore.name} />
                : currentStore.name
              : 'Pick a store'}
            <span style={{ opacity: 0.5 }}>▾</span>
          </button>
        </div>
      )}

      {/* ---------- search (always visible; "/" focuses it) ---------- */}
      <div className="searchbar">
        <input
          type="search"
          placeholder={deals ? 'Search deals…' : 'Search your items…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* ---------- view switch ---------- */}
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={deals ? 'on' : ''} onClick={() => { setView('deals'); exitSelect() }}>🏷️ Deals</button>
        <button className={!deals ? 'on' : ''} onClick={() => { setView('items'); exitSelect() }}>📋 All items</button>
      </div>

      {selecting && (
        <p className="muted small" style={{ marginTop: -4, marginBottom: 10 }}>
          Tap rows to select. Compare needs same-type products (weight with weight).
        </p>
      )}

      {/* ================= DEALS VIEW ================= */}
      {deals && (
        <>
          <Chips style={{ marginBottom: 8 }}>
            <button className={`no-check${meat ? ' on' : ''}`} onClick={() => setMode('meat')}>🥩 Meat</button>
            <button className={`no-check${meat ? '' : ' on'}`} onClick={() => setMode('grocery')}>🛒 Groceries</button>
            {meat && (
              <button
                className="no-check"
                style={{ marginLeft: 'auto' }}
                title="Natural / ultra-processed filter"
                onClick={() => setProc(proc === 'all' ? 'natural' : proc === 'natural' ? 'ultra' : 'all')}
              >
                {proc === 'all' ? 'All kinds' : PROCESSING_LABEL[proc]}
              </button>
            )}
          </Chips>

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

          {meat && (
            <Chips style={{ marginBottom: 8 }}>
              <button className="no-check" aria-label="Clear meat type selection" onClick={() => setTypesOff(new Set(MEAT_TYPES))}>✕</button>
              <button className="no-check" aria-label="Select all meat types" onClick={() => setTypesOff(new Set())}>All</button>
              {MEAT_TYPES.filter((t) => groups[t]?.length).map((t) => (
                <button key={t} className={typesOff.has(t) ? '' : 'on'} onClick={() => toggle(typesOff, setTypesOff, t)}>
                  {MEAT_TYPE_LABEL[t]}
                </button>
              ))}
            </Chips>
          )}
          {!meat && groceryCats.length > 1 && (
            <Chips style={{ marginBottom: 8 }}>
              <button className="no-check" aria-label="Clear category selection" onClick={() => setCatsOff(new Set(GROCERY_TYPES))}>✕</button>
              <button className="no-check" aria-label="Select all categories" onClick={() => setCatsOff(new Set())}>All</button>
              {groceryCats.map((t) => (
                <button key={t} className={catsOff.has(t) ? '' : 'on'} onClick={() => toggle(catsOff, setCatsOff, t)}>
                  {GROCERY_TYPE_LABEL[t]}
                </button>
              ))}
            </Chips>
          )}
          {dealStores.length > 1 && (
            <Chips style={{ marginBottom: 8 }}>
              <button className="no-check" aria-label="Clear store selection" onClick={() => setStoresOff(new Set(dealStores.map((s) => s.id)))}>✕</button>
              <button className="no-check" aria-label="Select all stores" onClick={() => setStoresOff(new Set())}>All</button>
              {dealStores.map((s) => (
                <button key={s.id} className={storesOff.has(s.id) ? '' : 'on'} onClick={() => toggle(storesOff, setStoresOff, s.id)}>
                  {s.name}
                </button>
              ))}
            </Chips>
          )}

          <Chips style={{ marginBottom: 8 }}>
            <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--muted)', flex: '0 0 auto' }}>Sort</span>
            {[['price', '$ Cheapest'], ['deal', '🔥 Best deal'], ['name', 'A–Z']].map(([k, label]) => (
              <button key={k} className={`no-check${sort === k ? ' on' : ''}`} onClick={() => setSort(k)}>
                {label}
              </button>
            ))}
            <button
              className={showExpired ? 'on' : ''}
              onClick={() => setShowExpired(!showExpired)}
              title="Also show expired flyer prices"
            >
              ⏰ Expired
            </button>
          </Chips>

          {sections.length === 0 && (
            <div className="empty" style={{ padding: 32 }}>
              <div className="ico">🏷️</div>
              No {meat ? 'meat' : 'grocery'} deals match the filters.
              <div className="sub small" style={{ marginTop: 6 }}>
                {meat
                  ? 'Deals appear here after the weekly flyer import finds prices below the usual Toronto market price.'
                  : 'Non-meat products with a current price show up here after the weekly flyer import (or a manual entry).'}
              </div>
            </div>
          )}

          <div className="grid-2">
            {sections.map(({ key, label, list }) => (
              <div key={key} style={{ marginTop: 10 }}>
                {label && <div className="lbl" style={{ marginBottom: 4 }}>{label}</div>}
                <div className="card list" style={{ padding: '2px 12px' }}>
                  {list.map((d) => {
                    const isSel = selected.includes(d.item.id)
                    const delta = lastBuyDelta(db, d)
                    return (
                      <button
                        key={d.key}
                        className={`row${isSel ? ' sel' : ''}`}
                        onPointerDown={() => holdStart(d)}
                        onPointerUp={holdEnd}
                        onPointerLeave={holdEnd}
                        onPointerCancel={holdEnd}
                        onContextMenu={(e) => e.preventDefault()}
                        onClick={() => {
                          if (press.current.long) { press.current.long = false; return }
                          if (selecting) return toggleSelect(d)
                          push({ name: 'item', itemId: d.item.id })
                        }}
                      >
                        <div className="grow">
                          <div className="title">
                            {selecting ? (isSel ? '☑️ ' : '⬜ ') : ''}
                            {d.item.name}
                            {!selecting && <PhotoLink name={d.item.name} />}
                          </div>
                          <div className="sub row-store">
                            {storeLogo(d.store.name) ? (
                              <img className="row-logo" src={storeLogo(d.store.name)} alt={d.store.name} title={d.store.name} />
                            ) : (
                              <span>{d.store.name}</span>
                            )}
                            {d.rec.validUntil && (
                              <span style={{ color: d.expired ? 'var(--muted)' : UNTIL_COLOR[untilUrgency(d.rec.validUntil)] }}>
                                {d.expired ? 'ended' : 'until'} {new Date(d.rec.validUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                              </span>
                            )}
                            {d.nRecs > 1 && (
                              <span className="muted" title={`${d.nRecs} prices in history`}>📊 {d.nRecs}</span>
                            )}
                            {delta != null && (
                              <span
                                className={`delta ${delta < 0 ? 'down' : 'up'}`}
                                title="vs the previous price in your history"
                              >
                                {delta < 0 ? '▼' : '▲'} {Math.abs(delta)}% vs last
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="right">
                          <div className="title">{fmtDisplay(d.norm, d.byPiece ? 'count' : d.item.kind, db.displayWeightUnit)}</div>
                          {d.byPiece && <span className="badge lvl-ok">📦 by piece</span>}
                          {d.rating && <span className={`badge ${RATING[d.rating].cls}`}>{RATING[d.rating].label}</span>}
                        </div>
                        {!selecting && (() => {
                          const st = rvState[d.key] ?? (rvSent.has(`${d.item.id}|${d.rec.id}`) ? 'ok' : undefined)
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
                        {!selecting && (
                          <RowMenu
                            open={menuFor === d.key}
                            onOpen={() => setMenuFor(menuFor === d.key ? null : d.key)}
                            actions={[
                              ['⚖️', 'Compare with…', () => startSelect(d)],
                              ['🔗', 'Merge with…', () => startSelect(d)],
                              ['🚫', "Don't import", () => { setMenuFor(null); setConfirmIgnore([d.item.id]) }],
                            ]}
                          />
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ================= ALL ITEMS VIEW ================= */}
      {!deals && (
        <>
          {noExactMatch && !selecting && (
            <button className="btn tonal" style={{ marginBottom: 12 }} onClick={() => startAdd({ query: q.trim() })}>
              + Add “{q.trim()}” with a price
            </button>
          )}

          {itemRows.length === 0 && (
            <div className="empty">
              <div className="ico">🧺</div>
              {q ? 'No items match.' : 'No items yet — tap ＋ to log your first price.'}
            </div>
          )}

          {itemRows.length > 0 && (
            <div className="card list" style={{ padding: '2px 12px' }}>
              {itemRows.map((row) => {
                const { item, variant, label, recs, key } = row
                const cheapest = pricesByStore(db, item.id, variant)[0]
                const norms = recs.map((r) => recordNorm(r, item, db)).filter((n) => n != null)
                const best = norms.length ? Math.min(...norms) : null
                const isSel = selected.includes(key)
                return (
                  <button
                    key={key}
                    className={`row${isSel ? ' sel' : ''}`}
                    onPointerDown={() => holdStart(row)}
                    onPointerUp={holdEnd}
                    onPointerLeave={holdEnd}
                    onPointerCancel={holdEnd}
                    onContextMenu={(e) => e.preventDefault()}
                    onClick={() => {
                      if (press.current.long) { press.current.long = false; return }
                      if (selecting) return toggleSelect(row)
                      push({ name: 'item', itemId: item.id, variant })
                    }}
                  >
                    <div className="grow">
                      <div className="title" style={{ whiteSpace: 'normal' }}>
                        {selecting ? (isSel ? '☑️ ' : '⬜ ') : ''}
                        {item.name}
                        {!selecting && <PhotoLink name={item.name} />}
                        {label && <span className="muted small"> ({label})</span>}
                        {(() => {
                          const fi = flyerInfo(recs[0])
                          return fi && (
                            <FlyerLink fi={fi} className={'badge ' + (fi.valid ? 'lvl-first' : 'lvl-ok')} style={{ marginLeft: 6, fontSize: 11, verticalAlign: 'middle' }} />
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
                      <div className="sub">{best != null ? 'best' : recs.length ? 'by piece' : ''}</div>
                    </div>
                    {!selecting && (
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
                    {!selecting && (
                      <RowMenu
                        open={menuFor === key}
                        onOpen={() => setMenuFor(menuFor === key ? null : key)}
                        actions={[
                          ['⚖️', 'Compare with…', () => startSelect(row)],
                          ['🔗', 'Merge with…', () => startSelect(row)],
                          ['🚫', "Don't import", () => { setMenuFor(null); setConfirmIgnore([item.id]) }],
                        ]}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ---------- dialogs ---------- */}
      {confirmIgnore && (
        <div className="modal-backdrop" onClick={() => setConfirmIgnore(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Don't import anymore 🚫</h2>
            <p className="muted small">
              {db.items.filter((i) => confirmIgnore.includes(i.id)).map((i) => i.name).join(', ')}
            </p>
            <ul className="muted small" style={{ paddingLeft: 18, margin: '8px 0 14px' }}>
              <li>Removes the product{confirmIgnore.length === 1 ? '' : 's'} and all saved prices — this can't be undone.</li>
              <li>The weekly flyer import will skip this <b>kind</b> of product from now on, any brand.</li>
              <li>Undo the ignore later in Settings.</li>
            </ul>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setConfirmIgnore(null)}>Cancel</button>
              <button className="btn danger" onClick={doIgnore}>Don't import</button>
            </div>
          </div>
        </div>
      )}

      {mergeName != null && (
        <div className="modal-backdrop" onClick={() => setMergeName(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Merge into one product 🔗</h2>
            <p className="muted small" style={{ marginTop: -4 }}>
              {selectedItems.map((i) => i.name).join(' + ')}
            </p>
            <label className="field" style={{ marginTop: 10 }}>
              <span className="lbl">Final name</span>
              <input
                type="text"
                value={mergeName}
                autoFocus
                onChange={(e) => setMergeName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doMerge()}
              />
            </label>
            <ul className="muted small" style={{ paddingLeft: 18, margin: '4px 0 14px' }}>
              <li>{mergeRecs.length} price{mergeRecs.length === 1 ? '' : 's'} kept, with their history.</li>
              {(() => {
                const t = targetUnit(selectedItems, mergeRecs)
                return t && <li>Prices converted to a single unit: <b>{t}</b>.</li>
              })()}
              {selectedItems.some((i) => i.category === 'meat') && !selectedItems.every((i) => i.category === 'meat') && (
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

      {storeSheet && (
        <StoreSheet db={db} update={update} onClose={() => setStoreSheet(false)} />
      )}

      {pendingAdd && (
        <StoreSheet
          db={db}
          update={update}
          onClose={() => setPendingAdd(null)}
          onPick={(store) => goAdd(pendingAdd, store.id)}
        />
      )}

      <div className="small muted" style={{ textAlign: 'center', marginTop: 20, opacity: 0.6 }}>
        Released {new Date(__BUILD_DATE__).toLocaleString()}
      </div>
    </div>
  )
}

// ⋮ overflow menu on a row — makes Merge / Don't import / Compare
// discoverable without knowing the long-press gesture.
function RowMenu({ open, onOpen, actions }) {
  return (
    <span className="menu-wrap hover-reveal" onPointerDown={(e) => e.stopPropagation()}>
      <span
        role="button"
        aria-label="More actions"
        className="icon-btn"
        style={{ width: 32, height: 32, fontSize: 16 }}
        onClick={(e) => { e.stopPropagation(); onOpen() }}
      >
        ⋮
      </span>
      {open && (
        <span className="menu" onClick={(e) => e.stopPropagation()}>
          {actions.map(([ico, label, fn]) => (
            <button key={label} onClick={fn}>
              <span>{ico}</span> {label}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
