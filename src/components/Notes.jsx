import { useState } from 'react'
import { uid } from '../lib/db'

const TYPES = {
  bug: { ico: '🐞', label: 'Bug' },
  idea: { ico: '💡', label: 'Idea' },
}

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'bug', label: '🐞 Bugs' },
  { id: 'idea', label: '💡 Ideas' },
  { id: 'done', label: 'Done' },
]

function matches(filter, n) {
  if (filter === 'open') return !n.done
  if (filter === 'done') return n.done
  return n.type === filter && !n.done
}

export default function Notes({ db, update }) {
  const [type, setType] = useState('bug')
  const [text, setText] = useState('')
  const [filter, setFilter] = useState('open')

  const notes = db.notes ?? []
  const openCount = notes.filter((n) => !n.done).length
  const shown = notes.filter((n) => matches(filter, n)).sort((a, b) => b.ts - a.ts)

  function add() {
    const t = text.trim()
    if (!t) return
    update((d) => {
      d.notes = d.notes ?? []
      d.notes.push({ id: uid('n'), type, text: t, done: false, ts: Date.now() })
    })
    setText('')
  }

  function toggle(id) {
    update((d) => {
      const n = d.notes.find((x) => x.id === id)
      n.done = !n.done
    })
  }

  function remove(id) {
    if (!confirm('Delete this note?')) return
    update((d) => { d.notes = d.notes.filter((x) => x.id !== id) })
  }

  return (
    <div className="card">
      <h2>Bugs &amp; ideas {openCount > 0 && <span className="muted small">· {openCount} open</span>}</h2>
      <p className="muted small" style={{ marginBottom: 12 }}>
        Jot down anything to fix or build later. Synced with the rest of your data.
      </p>

      <div className="seg" style={{ marginBottom: 8 }}>
        {Object.entries(TYPES).map(([k, v]) => (
          <button key={k} className={type === k ? 'on' : ''} onClick={() => setType(k)}>
            {v.ico} {v.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          type="text"
          placeholder={type === 'bug' ? 'What went wrong?' : 'What should it do?'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="btn small" onClick={add} disabled={!text.trim()}>Add</button>
      </div>

      <div className="seg" style={{ marginBottom: 4 }}>
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="muted small" style={{ textAlign: 'center', padding: '18px 0' }}>
          {filter === 'done' ? 'Nothing done yet.' : 'Nothing here — add one above.'}
        </p>
      ) : (
        <div className="list">
          {shown.map((n) => (
            <div key={n.id} className="row" style={{ cursor: 'default' }}>
              <button
                onClick={() => toggle(n.id)}
                aria-label={n.done ? 'Mark as open' : 'Mark as done'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, fontSize: 17 }}
              >
                {n.done ? '☑️' : '⬜️'}
              </button>
              <div className="grow">
                <div
                  className="title"
                  style={{ whiteSpace: 'normal', opacity: n.done ? 0.5 : 1, textDecoration: n.done ? 'line-through' : 'none' }}
                >
                  {TYPES[n.type].ico} {n.text}
                </div>
                <div className="sub">{new Date(n.ts).toLocaleDateString()}</div>
              </div>
              <button
                className="chev"
                onClick={() => remove(n.id)}
                aria-label="Delete note"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6 }}
              >
                🗑️
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
