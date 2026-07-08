import { useRef, useState } from 'react'
import { exportJSON, DEFAULT_DB } from '../lib/db'
import { UNITS } from '../lib/units'

function replaceDB(update, data) {
  update((d) => {
    Object.keys(d).forEach((k) => delete d[k])
    Object.assign(d, structuredClone(DEFAULT_DB), data)
  })
}

export default function Settings({ db, update, user, onSignOut }) {
  const fileRef = useRef(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [renameVal, setRenameVal] = useState('')

  function importFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result)
        if (!Array.isArray(data.stores) || !Array.isArray(data.records)) throw new Error()
        delete data.pinHash
        replaceDB(update, data)
      } catch {
        alert('Invalid backup file.')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div className="screen">
      <div className="topbar">
        <h1>Settings ⚙️</h1>
      </div>

      <div className="card">
        <h2>Stores</h2>
        <div className="list">
          {db.stores.map((s) => (
            <div key={s.id} className="row" style={{ cursor: 'default' }}>
              <span style={{ width: 14, height: 14, borderRadius: 4, background: s.color, flexShrink: 0 }} />
              {renaming === s.id ? (
                <input
                  type="text"
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => {
                    if (renameVal.trim())
                      update((d) => { d.stores.find((x) => x.id === s.id).name = renameVal.trim() })
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                  style={{ padding: 8, fontSize: 15 }}
                />
              ) : (
                <div className="grow">
                  <div className="title">{s.name}</div>
                  <div className="sub">default unit: {UNITS[s.defaultUnit]?.label}</div>
                </div>
              )}
              <select
                value={s.defaultUnit}
                onChange={(e) => update((d) => { d.stores.find((x) => x.id === s.id).defaultUnit = e.target.value })}
                style={{ width: 76, padding: '8px 6px', fontSize: 14 }}
              >
                {Object.keys(UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <button
                className="chev"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6 }}
                onClick={() => { setRenaming(s.id); setRenameVal(s.name) }}
                aria-label="Rename store"
              >
                ✏️
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Backup</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Your data syncs to your Google account. Export a JSON copy anytime.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" onClick={() => exportJSON(db)}>⬇️ Export</button>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>⬆️ Import</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={importFile} />
        </div>
      </div>

      <div className="card">
        <h2>Account</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>Signed in as {user.email}</p>
        <button className="btn ghost" onClick={onSignOut}>🚪 Sign out</button>
      </div>

      <div className="card">
        <h2>Danger zone</h2>
        {!confirmWipe ? (
          <button className="btn danger" onClick={() => setConfirmWipe(true)}>Delete all data</button>
        ) : (
          <>
            <p className="small" style={{ marginBottom: 10 }}>
              This permanently deletes every item, store and price record. Export a backup first!
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setConfirmWipe(false)}>Cancel</button>
              <button
                className="btn danger"
                onClick={() => {
                  replaceDB(update, {})
                  setConfirmWipe(false)
                }}
              >
                Yes, delete everything
              </button>
            </div>
          </>
        )}
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 10 }}>
        Smart Price · synced with Firebase
      </p>
    </div>
  )
}
