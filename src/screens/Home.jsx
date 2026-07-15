import { useMemo, useRef, useState } from 'react'
import { fmtDisplay } from '../lib/units'
import { meatDeals, MEAT_TYPES, MEAT_TYPE_LABEL, PROCESSING_LABEL, RATING } from '../lib/meat'
import PhotoLink from '../components/PhotoLink'
import CompareReport from '../components/CompareReport'

// Home = current meat deals, grouped Beef/Pork/Chicken/Fish; ultra-processed
// items get their own "<Type> · ultra-processed" section after the natural
// one. Expired flyer prices never show. Multiselect chips filter by store and
// deal rating (default: excellent + good, all stores). Store picking lives in
// the Location tab.
const RATING_KEYS = Object.keys(RATING)

// Horizontally scrollable chip row; wheel + drag scrolling for mouse users
// (the scrollbar is hidden and mice have no horizontal wheel).
function Chips({ children, style }) {
  const drag = (e) => {
    const el = e.currentTarget
    const startX = e.clientX
    const startLeft = el.scrollLeft
    const move = (ev) => { el.scrollLeft = startLeft - (ev.clientX - startX) }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      className="chips"
      style={style}
      onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY + e.deltaX }}
      onPointerDown={(e) => { if (e.pointerType === 'mouse') drag(e) }}
    >
      {children}
    </div>
  )
}

export default function Home({ db, push }) {
  const groups = useMemo(() => meatDeals(db), [db])
  const [ratingsOn, setRatingsOn] = useState(() => new Set(['excellent', 'good']))
  const [storesOff, setStoresOff] = useState(() => new Set())
  const [typesOff, setTypesOff] = useState(() => new Set())
  const [proc, setProc] = useState('all') // cycles all -> natural -> ultra
  const [sort, setSort] = useState('price') // 'price' | 'deal' | 'name'
  // Long-press a deal row to enter compare mode (same ⚖️ tool as the Items tab);
  // tap more rows to select, tray at the bottom runs the report.
  const [comparing, setComparing] = useState(false)
  const [selected, setSelected] = useState([]) // item ids
  const [report, setReport] = useState(false)
  const press = useRef({ timer: null, long: false })

  const dealStores = useMemo(() => {
    const map = new Map()
    for (const t of MEAT_TYPES) for (const d of groups[t] ?? []) map.set(d.store.id, d.store)
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [groups])

  const toggle = (set, setSet, key) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSet(next)
  }

  // Items with no market data (rating null) always pass the rating filter.
  const show = (d) =>
    !storesOff.has(d.store.id) &&
    (proc === 'all' || (proc === 'ultra') === d.ultra) &&
    (d.rating == null || ratingsOn.has(d.rating))

  // 'deal' = biggest discount vs the item's market avg price; no-market last.
  const dealScore = (d) => (d.item.market ? d.norm / d.item.market.avg : Infinity)
  const cmp = {
    price: (a, b) => a.norm - b.norm,
    deal: (a, b) => dealScore(a) - dealScore(b),
    name: (a, b) => a.item.name.localeCompare(b.item.name),
  }[sort]

  // One section per meat type for natural items, followed by a separate
  // "<Type> · ultra-processed" section when the type has ultra items.
  const sections = MEAT_TYPES.flatMap((t) => {
    if (typesOff.has(t)) return []
    const list = (groups[t] ?? []).filter(show).sort(cmp)
    const natural = list.filter((d) => !d.ultra)
    const ultra = list.filter((d) => d.ultra)
    const out = []
    if (natural.length) out.push({ key: t, label: MEAT_TYPE_LABEL[t], list: natural })
    if (ultra.length) out.push({ key: `${t}-ultra`, label: `${MEAT_TYPE_LABEL[t]} · ultra-processed`, list: ultra })
    return out
  })

  const allDeals = MEAT_TYPES.flatMap((t) => groups[t] ?? [])
  const selectedDeals = allDeals.filter((d) => selected.includes(d.item.id))
  const compareKind = selectedDeals[0]?.item.kind ?? null
  // CompareReport rows: variant null = compare across all the item's records
  const compareRows = selectedDeals.map((d) => ({ item: d.item, variant: null, label: '', key: d.item.id }))

  function holdStart(d) {
    if (comparing) return
    press.current.long = false
    press.current.timer = setTimeout(() => {
      press.current.long = true
      setComparing(true)
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
    <div className="screen" style={comparing ? { paddingBottom: 170 } : undefined}>
      <div className="topbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1>{comparing ? 'Pick items ⚖️' : '🥩 Meat deals'}</h1>
        {!comparing && (
          <button
            className="btn small ghost"
            onClick={() => setProc(proc === 'all' ? 'natural' : proc === 'natural' ? 'ultra' : 'all')}
          >
            {proc === 'all' ? 'All' : PROCESSING_LABEL[proc]}
          </button>
        )}
      </div>

      {comparing && (
        <p className="muted small" style={{ marginTop: -8, marginBottom: 10 }}>
          Tap the deals you want to compare.
        </p>
      )}

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
      <Chips style={{ marginBottom: 8 }}>
        <button
          aria-label="Clear meat type selection"
          onClick={() => setTypesOff(new Set(MEAT_TYPES))}
        >
          ✕
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
      {dealStores.length > 1 && (
        <Chips style={{ marginBottom: 8 }}>
          <button
            aria-label="Clear store selection"
            onClick={() => setStoresOff(new Set(dealStores.map((s) => s.id)))}
          >
            ✕
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
        {[['price', '$ Cheapest'], ['deal', '🔥 Best deal'], ['name', 'A–Z']].map(([k, label]) => (
          <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
            {label}
          </button>
        ))}
      </Chips>

      {sections.length === 0 && (
        <div className="empty" style={{ padding: 32 }}>
          No meat deals match the filters.
          <div className="sub" style={{ marginTop: 6 }}>
            Deals appear here after the weekly flyer import finds prices below the usual Toronto market price.
          </div>
        </div>
      )}

      {sections.map(({ key, label, list }) => (
        <div key={key} style={{ marginTop: 10 }}>
          <div className="lbl" style={{ marginBottom: 4 }}>{label}</div>
          <div className="card list" style={{ padding: '2px 14px' }}>
            {list.map((d) => {
              const isSel = selected.includes(d.item.id)
              const disabled = comparing && compareKind && d.item.kind !== compareKind && !isSel
              return (
              <button
                key={d.item.id}
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
                  push({ name: 'item', itemId: d.item.id })
                }}
              >
                <div className="grow">
                  <div className="title">
                    {comparing ? (isSel ? '☑️ ' : '⬜ ') : ''}
                    {d.item.name}
                    {!comparing && <PhotoLink name={d.item.name} />}
                  </div>
                  <div className="sub">
                    cheapest @ {d.store.name}
                    {d.rec.validUntil ? ` · until ${new Date(d.rec.validUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
                  </div>
                </div>
                <div className="right">
                  <div className="title">{fmtDisplay(d.norm, d.item.kind, db.displayWeightUnit)}</div>
                  {d.rating && <span className={`badge ${RATING[d.rating].cls}`}>{RATING[d.rating].label}</span>}
                </div>
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

      <div className="small muted" style={{ textAlign: 'center', marginTop: 16, opacity: 0.6 }}>
        Released {new Date(__BUILD_DATE__).toLocaleString()}
      </div>
    </div>
  )
}
