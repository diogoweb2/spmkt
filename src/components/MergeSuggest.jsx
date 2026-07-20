import { useState } from 'react'
import { memberNames } from '../lib/merge'
import { fmtQty } from '../lib/units'

// 🔗 Merge suggestions (BUSINESS_RULES §15d). A list of existing products that
// look like the one just saved/approved, each with a checkbox and an expansion
// arrow. Expanding shows the real product names behind a (possibly already
// merged) generic item — "beef burger" reveals every store-specific name its
// records were logged under, so the merge decision is an informed one.
// Suggestions are name-similarity only: no AI call.
export function SuggestionList({ db, suggestions, selected, onToggle }) {
  return (
    <div className="merge-suggest">
      {suggestions.map(({ item, score }) => (
        <SuggestionRow
          key={item.id}
          db={db}
          item={item}
          score={score}
          on={selected.includes(item.id)}
          onToggle={() => onToggle(item.id)}
        />
      ))}
    </div>
  )
}

function SuggestionRow({ db, item, score, on, onToggle }) {
  const [open, setOpen] = useState(false)
  const names = open ? memberNames(db, item) : []
  const records = db.records.filter((r) => r.itemId === item.id)
  return (
    <div className={`ms-row${on ? ' on' : ''}`}>
      <div className="ms-head">
        <input type="checkbox" checked={on} onChange={onToggle} aria-label={`Merge with ${item.name}`} />
        <button type="button" className="ms-name" onClick={onToggle}>
          <span className="t">{item.name}</span>
          <span className="muted small">
            {records.length} price{records.length === 1 ? '' : 's'}
            {names.length > 1 || score < 1 ? ` · ${Math.round(score * 100)}% match` : ''}
          </span>
        </button>
        <button
          type="button"
          className="ms-expand"
          aria-expanded={open}
          aria-label={open ? 'Hide product names' : 'Show product names'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <ul className="ms-members">
          {names.map((n) => <li key={n}>{n}</li>)}
          {records.slice(0, 6).map((r) => (
            <li key={r.id} className="muted">
              {db.stores.find((s) => s.id === r.storeId)?.name ?? 'store'} · ${r.price}
              {r.qty === 1 ? `/${r.unit}` : ` · ${fmtQty(r.qty, r.unit)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// The "name this merge" dialog shared by Photo Live and Review. `defaultName`
// is prefilled by suggestName (an existing group's name wins).
export function MergeNameDialog({ names, value, onChange, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Merge into one product 🔗</h2>
        <p className="muted small" style={{ marginTop: -4 }}>{names.join(' + ')}</p>
        <label className="field" style={{ marginTop: 10 }}>
          <span className="lbl">Final name</span>
          <input
            type="text"
            value={value}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && value.trim() && onConfirm()}
          />
        </label>
        <p className="muted small" style={{ margin: '0 0 14px' }}>
          Every price is kept; the original product names stay visible in the history.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn" disabled={!value.trim()} onClick={onConfirm}>Merge</button>
        </div>
      </div>
    </div>
  )
}
