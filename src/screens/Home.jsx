import { useMemo, useState } from 'react'
import { fmtDisplay } from '../lib/units'
import { meatDeals, MEAT_TYPES, MEAT_TYPE_LABEL, PROCESSING_LABEL, RATING } from '../lib/meat'

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
  const [proc, setProc] = useState('all') // 'all' | 'natural' | 'ultra'

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

  // One section per meat type for natural items, followed by a separate
  // "<Type> · ultra-processed" section when the type has ultra items.
  const sections = MEAT_TYPES.flatMap((t) => {
    if (typesOff.has(t)) return []
    const list = (groups[t] ?? []).filter(show)
    const natural = list.filter((d) => !d.ultra)
    const ultra = list.filter((d) => d.ultra)
    const out = []
    if (natural.length) out.push({ key: t, label: MEAT_TYPE_LABEL[t], list: natural })
    if (ultra.length) out.push({ key: `${t}-ultra`, label: `${MEAT_TYPE_LABEL[t]} · ultra-processed`, list: ultra })
    return out
  })

  return (
    <div className="screen">
      <div className="topbar">
        <h1>🥩 Meat deals</h1>
      </div>

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
        {MEAT_TYPES.filter((t) => groups[t]?.length).map((t) => (
          <button
            key={t}
            className={typesOff.has(t) ? '' : 'on'}
            onClick={() => toggle(typesOff, setTypesOff, t)}
          >
            {MEAT_TYPE_LABEL[t]}
          </button>
        ))}
        {['all', 'natural', 'ultra'].map((p) => (
          <button
            key={p}
            className={proc === p ? 'on' : ''}
            onClick={() => setProc(p)}
          >
            {p === 'all' ? 'All' : PROCESSING_LABEL[p]}
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
            {list.map((d) => (
              <button key={d.item.id} className="row" onClick={() => push({ name: 'item', itemId: d.item.id })}>
                <div className="grow">
                  <div className="title">{d.item.name}</div>
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
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
