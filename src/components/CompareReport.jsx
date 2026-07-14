import { pricesByStore } from '../lib/analysis'
import { fmtDisplay, fmtMoney, fmtQty } from '../lib/units'
import { effectivePrice } from '../lib/cashback'

// Ranked comparison using each store's LATEST price per product (never old prices).
// rows: [{ item, variant, label, key }]
export default function CompareReport({ db, rows, onBack, onDone }) {
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
