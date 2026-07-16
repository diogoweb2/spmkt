import { useEffect, useRef, useState } from 'react'
import { exportJSON, DEFAULT_DB } from '../lib/db'
import { UNITS } from '../lib/units'
import { unignore } from '../lib/ignore'
import { addWhitelistRule, removeWhitelistRule, whitelistRules } from '../lib/whitelist'
import { cashbackEnabled } from '../lib/cashback'
import { enablePush, pushSupported } from '../lib/push'
import Notes from '../components/Notes'
import Chips from '../components/Chips'

// Settings is split into scrollable tabs — one per topic, so the screen
// isn't one endless column of cards.
const TABS = [
  ['stores', '🏪 Stores'],
  ['import', '📰 Import'],
  ['cashback', '💳 Cashback'],
  ['alerts', '🔔 Alerts'],
  ['notes', '📝 Notes'],
  ['data', '💾 Data'],
]

function replaceDB(update, data) {
  update((d) => {
    Object.keys(d).forEach((k) => delete d[k])
    Object.assign(d, structuredClone(DEFAULT_DB), data)
  })
}

export default function Settings({ db, update, onSignOut }) {
  const fileRef = useRef(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [pushOk, setPushOk] = useState(null) // null = unknown, true/false = supported
  const [wlText, setWlText] = useState('')
  const [tab, setTab] = useState('stores')
  const [pushMsg, setPushMsg] = useState('')
  const [pushing, setPushing] = useState(false)

  useEffect(() => { pushSupported().then(setPushOk) }, [])

  async function turnOnPush() {
    setPushing(true)
    setPushMsg('')
    try {
      const token = await enablePush()
      update((d) => {
        d.pushTokens ??= []
        const existing = d.pushTokens.find((t) => t.token === token)
        if (existing) existing.ts = Date.now()
        else d.pushTokens.push({ token, ua: navigator.userAgent, ts: Date.now() })
      })
      setPushMsg('✅ This device will be notified when the weekly flyer sync runs.')
    } catch (err) {
      setPushMsg(`⚠️ ${err.message}`)
    } finally {
      setPushing(false)
    }
  }

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

      <Chips style={{ marginBottom: 12 }}>
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </Chips>

      {tab === 'stores' && (
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
      )}

      {tab === 'import' && (db.ignored ?? []).length > 0 && (
        <div className="card">
          <h2>Ignored products 🚫</h2>
          <p className="muted small" style={{ marginBottom: 12 }}>
            The flyer import skips these kinds of products, whatever the brand.
          </p>
          <div className="list">
            {db.ignored.map((g) => (
              <div key={g.id} className="row" style={{ cursor: 'default' }}>
                <div className="grow title" style={{ whiteSpace: 'normal', fontSize: 15 }}>{g.name}</div>
                <button
                  className="btn small ghost"
                  onClick={() => update((d) => unignore(d, g.id))}
                >
                  Stop ignoring
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'import' && (
      <div className="card">
        <h2>Import whitelist ✅</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>
          When on, the weekly flyer import only brings in products matching these keywords —
          <b> meat is always imported</b> (ignore unwanted meat from the Home list). Plain
          language works, exceptions included: “Yogurt but only Greek style”, “Chips but not
          Pringles”, “all fruits but not organic”.
        </p>
        <label className="row" style={{ cursor: 'pointer', gap: 10 }}>
          <input
            type="checkbox"
            checked={!!db.whitelistOn}
            onChange={(e) => update((d) => { d.whitelistOn = e.target.checked })}
          />
          <span className="title" style={{ fontSize: 15 }}>Only import whitelisted products</span>
        </label>
        {db.whitelistOn && whitelistRules(db).length === 0 && (
          <p className="muted small" style={{ marginTop: 8 }}>
            No keywords yet — the import still brings in everything until you add one.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'stretch' }}>
          <input
            type="text"
            placeholder="e.g. Chips but not Pringles"
            value={wlText}
            onChange={(e) => setWlText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && wlText.trim()) {
                update((d) => addWhitelistRule(d, wlText))
                setWlText('')
              }
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            className="btn small ghost"
            style={{ flexShrink: 0 }}
            disabled={!wlText.trim()}
            onClick={() => {
              update((d) => addWhitelistRule(d, wlText))
              setWlText('')
            }}
          >
            Add
          </button>
        </div>
        {whitelistRules(db).length > 0 && (
          <div className="list" style={{ marginTop: 8 }}>
            {whitelistRules(db).map((r) => (
              <div key={r.id} className="row" style={{ cursor: 'default' }}>
                <div className="grow title" style={{ whiteSpace: 'normal', fontSize: 15 }}>{r.text}</div>
                <button
                  className="btn small ghost"
                  onClick={() => update((d) => removeWhitelistRule(d, r.id))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {tab === 'cashback' && (
      <div className="card">
        <h2>Card cashback 💳</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Show and compare all prices after cashback: 5% (Amex) at Metro, Food Basics, Sobeys,
          FreshCo, Longo's, Whole Foods and Farm Boy · 1.5% (Mastercard) everywhere else.
        </p>
        <label className="row" style={{ cursor: 'pointer', gap: 10 }}>
          <input
            type="checkbox"
            checked={cashbackEnabled(db)}
            onChange={(e) => update((d) => { d.cashback = e.target.checked })}
          />
          <span className="title" style={{ fontSize: 15 }}>Apply cashback to prices</span>
        </label>
      </div>
      )}

      {tab === 'alerts' && (
      <div className="card">
        <h2>Notifications 🔔</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Get a push on this device when the weekly flyer sync finishes — with how many
          new deals were imported, or if anything failed.
        </p>
        {pushOk === false ? (
          <p className="small muted">
            This browser can’t receive push notifications. On iPhone, add Smart Price to your
            Home Screen first (Share → Add to Home Screen), then open it from there.
          </p>
        ) : (
          <button className="btn ghost" onClick={turnOnPush} disabled={pushing || pushOk === null}>
            {pushing ? 'Enabling…' : '🔔 Notify this device'}
          </button>
        )}
        {pushMsg && <p className="small" style={{ marginTop: 10 }}>{pushMsg}</p>}
        {(db.pushTokens ?? []).length > 0 && (
          <p className="muted small" style={{ marginTop: 10 }}>
            {db.pushTokens.length} device{db.pushTokens.length > 1 ? 's' : ''} registered.
          </p>
        )}
      </div>
      )}

      {tab === 'notes' && <Notes db={db} update={update} />}

      {tab === 'data' && (
      <>
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
        <h2>Security</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Unlocked with the shared family password. Change it in the Firebase console (Authentication).
        </p>
        <button className="btn ghost" onClick={onSignOut}>🔒 Lock app (ask password again)</button>
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
      </>
      )}

      <p className="muted small" style={{ textAlign: 'center', marginTop: 10 }}>
        Smart Price · synced with Firebase
      </p>
    </div>
  )
}
