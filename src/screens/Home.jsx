import { Fragment, useMemo } from 'react'
import { fmtDisplay } from '../lib/units'
import { meatDeals, MEAT_TYPES, MEAT_TYPE_LABEL, RATING } from '../lib/meat'

// Home = current meat deals, grouped Beef/Pork/Chicken/Fish, natural products
// first with ultra-processed chips + subheading. Only excellent/good deals
// show; expired flyer prices never do. Store picking lives in the Location tab.
export default function Home({ db, push }) {
  const groups = useMemo(() => meatDeals(db), [db])
  const types = MEAT_TYPES.filter((t) => groups[t]?.length)

  return (
    <div className="screen">
      <div className="topbar">
        <h1>🥩 Meat deals</h1>
      </div>

      {types.length === 0 && (
        <div className="empty" style={{ padding: 32 }}>
          No good meat deals right now.
          <div className="sub" style={{ marginTop: 6 }}>
            Deals appear here after the weekly flyer import finds prices below the usual Toronto market price.
          </div>
        </div>
      )}

      {types.map((t) => {
        const firstUltra = groups[t].findIndex((d) => d.ultra)
        return (
          <div key={t} style={{ marginTop: 10 }}>
            <div className="lbl" style={{ marginBottom: 4 }}>{MEAT_TYPE_LABEL[t]}</div>
            <div className="card list" style={{ padding: '2px 14px' }}>
              {groups[t].map((d, idx) => (
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
