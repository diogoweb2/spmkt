import { Fragment, useMemo, useState } from 'react'
import { fmtDisplay } from '../lib/units'
import { meatDeals, MEAT_TYPES, MEAT_TYPE_LABEL, RATING } from '../lib/meat'

// Home = current meat deals, grouped Beef/Pork/Chicken/Fish, natural products
// first with ultra-processed chips + subheading. Expired flyer prices never
// show. Multiselect chips filter by store and deal rating (default:
// excellent + good, all stores). Store picking lives in the Location tab.
const RATING_KEYS = Object.keys(RATING)

export default function Home({ db, push }) {
  const groups = useMemo(() => meatDeals(db), [db])
  const [ratingsOn, setRatingsOn] = useState(() => new Set(['excellent', 'good']))
  const [storesOff, setStoresOff] = useState(() => new Set())

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
    !storesOff.has(d.store.id) && (d.rating == null || ratingsOn.has(d.rating))

  const types = MEAT_TYPES.filter((t) => groups[t]?.some(show))

  return (
    <div className="screen">
      <div className="topbar">
        <h1>🥩 Meat deals</h1>
      </div>

      <div className="chips" style={{ marginBottom: 8 }}>
        {RATING_KEYS.map((r) => (
          <button
            key={r}
            className={ratingsOn.has(r) ? 'on' : ''}
            onClick={() => toggle(ratingsOn, setRatingsOn, r)}
          >
            {RATING[r].label.replace(' deal', '')}
          </button>
        ))}
      </div>
      {dealStores.length > 1 && (
        <div className="chips" style={{ marginBottom: 8 }}>
          {dealStores.map((s) => (
            <button
              key={s.id}
              className={storesOff.has(s.id) ? '' : 'on'}
              onClick={() => toggle(storesOff, setStoresOff, s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {types.length === 0 && (
        <div className="empty" style={{ padding: 32 }}>
          No meat deals match the filters.
          <div className="sub" style={{ marginTop: 6 }}>
            Deals appear here after the weekly flyer import finds prices below the usual Toronto market price.
          </div>
        </div>
      )}

      {types.map((t) => {
        const list = groups[t].filter(show)
        const firstUltra = list.findIndex((d) => d.ultra)
        return (
          <div key={t} style={{ marginTop: 10 }}>
            <div className="lbl" style={{ marginBottom: 4 }}>{MEAT_TYPE_LABEL[t]}</div>
            <div className="card list" style={{ padding: '2px 14px' }}>
              {list.map((d, idx) => (
                <Fragment key={d.item.id}>
                  {idx === firstUltra && (
                    <div className="sub" style={{ padding: '8px 2px 0', color: 'var(--muted)', fontSize: 12 }}>
                      Ultra-processed
                    </div>
                  )}
                  <button className="row" onClick={() => push({ name: 'item', itemId: d.item.id })}>
                    <div className="grow">
                      <div className="title">
                        {d.item.name}
                        {d.ultra && <span className="badge lvl-ok" style={{ marginLeft: 6 }}>ultra-processed</span>}
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
                </Fragment>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
