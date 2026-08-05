// 📄 Flyers (BUSINESS_RULES §17): browse a store's flyer page by page and drag
// a box around each deal worth importing. Every box is cropped in the browser
// and queued as a photo (§15), so the existing daily vision job extracts it and
// the Review tab shows it as an approve/edit card — no new import pipeline.
//
// This replaced the automatic whole-flyer extraction: reading 10-40 dense pages
// per store kept dropping the big front-page deals (the ones that matter most)
// and cost a model call per page pair. Drawing the box IS the decision about
// what to import, so the model only ever sees one deal at a time.

import { useEffect, useRef, useState } from 'react'
import { FLYER_STORES, loadFlyer, cropPage } from '../lib/flyers'
import { addPhoto } from '../lib/photos'
import { uid } from '../lib/db'

// A drag shorter than this in either direction is a tap (or a slip while
// scrolling), not a deal box — ignore it instead of queueing a sliver.
const MIN_BOX = 0.02

export default function Flyers({ db, update }) {
  const [store, setStore] = useState(FLYER_STORES[0])
  const [upcoming, setUpcoming] = useState(false)
  const [flyer, setFlyer] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(null) // 1-based page being cropped, null = page grid
  const [zoom, setZoom] = useState(1)
  // id -> {page, box, status} for boxes drawn this session, so the user can see
  // what they already queued on a page (the queue entry itself has no page).
  const [queued, setQueued] = useState([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setFlyer(null)
    setPage(null)
    loadFlyer(store, { upcoming })
      .then((f) => !cancelled && setFlyer(f))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [store, upcoming])

  // The db store this flyer belongs to, created on first crop so a queued deal
  // always lands on a real store (the queue entry only carries the id).
  // The id is minted HERE, not inside update(): React defers the mutator, so a
  // value written in it can't be read back on the next line. The push is
  // guarded so StrictMode's double-invoke can't add the store twice.
  const resolveStoreId = () => {
    const existing = db.stores.find((x) => x.name.toLowerCase() === store.name.toLowerCase())
    if (existing) return existing.id
    const id = uid('s')
    update((d) => {
      if (!d.stores.some((x) => x.name.toLowerCase() === store.name.toLowerCase())) {
        d.stores.push({ id, name: store.name, color: '#0d9488', defaultUnit: 'lb' })
      }
    })
    return id
  }

  const queueBox = async (pageNo, box) => {
    const localId = uid('b')
    setQueued((q) => [...q, { id: localId, page: pageNo, box, status: 'saving' }])
    try {
      const blob = await cropPage(flyer.pages[pageNo - 1], box)
      const storeId = resolveStoreId()
      await addPhoto(update, blob, storeId, {
        source: 'flyer',
        validUntil: flyer.validUntil,
        flyerUrl: flyer.url,
        flyerPage: pageNo,
        ...(upcoming ? { upcoming: true } : {}),
      })
      setQueued((q) => q.map((b) => (b.id === localId ? { ...b, status: 'done' } : b)))
    } catch (err) {
      setQueued((q) => q.map((b) => (b.id === localId ? { ...b, status: 'failed', error: err.message } : b)))
    }
  }

  const nQueued = queued.filter((b) => b.status === 'done').length

  return (
    <div className="screen">
      <h1>📄 Flyers</h1>

      <div className="chips">
        {FLYER_STORES.map((s) => (
          <button key={s.name} className={`chip${s.name === store.name ? ' on' : ''}`} onClick={() => setStore(s)}>
            {s.name}
          </button>
        ))}
      </div>

      <div className="chips">
        <button className={`chip${upcoming ? ' on' : ''}`} onClick={() => setUpcoming((v) => !v)}>
          🔜 Next week
        </button>
        {flyer?.validUntil && (
          <span className="muted small" style={{ alignSelf: 'center' }}>
            until {new Date(flyer.validUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
        {nQueued > 0 && (
          <span className="muted small" style={{ alignSelf: 'center' }}>
            · {nQueued} queued for Review
          </span>
        )}
      </div>

      {loading && <p className="muted small">Loading the {store.name} flyer…</p>}
      {error && <p className="muted small">{error}</p>}

      {flyer && page == null && (
        <PageGrid
          pages={flyer.pages}
          queued={queued}
          onPick={(n) => {
            setPage(n)
            setZoom(1)
          }}
        />
      )}

      {flyer && page != null && (
        <PageCropper
          url={flyer.pages[page - 1]}
          page={page}
          pageCount={flyer.pages.length}
          zoom={zoom}
          setZoom={setZoom}
          boxes={queued.filter((b) => b.page === page)}
          onBox={(box) => queueBox(page, box)}
          onBack={() => setPage(null)}
          onPage={(n) => setPage(n)}
        />
      )}
    </div>
  )
}

// Thumbnail grid: every page of the flyer, with a count of the boxes already
// drawn on each so a long flyer stays navigable across sittings.
function PageGrid({ pages, queued, onPick }) {
  return (
    <div className="flyer-grid">
      {pages.map((url, i) => {
        const n = i + 1
        const done = queued.filter((b) => b.page === n && b.status === 'done').length
        return (
          <button key={url} className="flyer-thumb" onClick={() => onPick(n)}>
            <img src={url} alt={`Page ${n}`} loading="lazy" />
            <span className="flyer-thumb-no">{n}</span>
            {done > 0 && <span className="flyer-thumb-done">✓ {done}</span>}
          </button>
        )
      })}
    </div>
  )
}

// One page, drag to draw a box around a deal. Pointer events (mouse + touch),
// with touch-action none on the image so a drag draws instead of scrolling the
// page. Coordinates are normalized against the rendered image box, so they stay
// correct at any zoom and the crop is taken from the full-resolution image.
function PageCropper({ url, page, pageCount, zoom, setZoom, boxes, onBox, onBack, onPage }) {
  const wrapRef = useRef(null)
  const [drag, setDrag] = useState(null) // {x0, y0, x, y} normalized

  const norm = (e) => {
    const r = wrapRef.current.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const down = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = norm(e)
    setDrag({ x0: p.x, y0: p.y, x: p.x, y: p.y })
  }
  const move = (e) => {
    if (!drag) return
    const p = norm(e)
    setDrag((d) => ({ ...d, x: p.x, y: p.y }))
  }
  const up = () => {
    if (!drag) return
    const box = {
      x: Math.min(drag.x0, drag.x),
      y: Math.min(drag.y0, drag.y),
      w: Math.abs(drag.x - drag.x0),
      h: Math.abs(drag.y - drag.y0),
    }
    setDrag(null)
    if (box.w >= MIN_BOX && box.h >= MIN_BOX) onBox(box)
  }

  const live = drag && {
    x: Math.min(drag.x0, drag.x),
    y: Math.min(drag.y0, drag.y),
    w: Math.abs(drag.x - drag.x0),
    h: Math.abs(drag.y - drag.y0),
  }

  return (
    <div>
      <div className="chips">
        <button className="chip" onClick={onBack}>
          ← All pages
        </button>
        <button className="chip" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹
        </button>
        <span className="muted small" style={{ alignSelf: 'center' }}>
          Page {page} / {pageCount}
        </span>
        <button className="chip" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
          ›
        </button>
        {/* no-check: these are a zoom level, not a filter — the ✓ prefix reads wrong */}
        {[1, 2, 3].map((z) => (
          <button key={z} className={`no-check${zoom === z ? ' on' : ''}`} onClick={() => setZoom(z)}>
            {z}×
          </button>
        ))}
      </div>

      <p className="muted small">Drag a box around a deal — the crop goes to Review.</p>

      <div className="flyer-page-scroll">
        <div ref={wrapRef} className="flyer-page" style={{ width: `${zoom * 100}%` }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <img src={url} alt={`Page ${page}`} draggable={false} />
          {boxes.map((b) => (
            <span
              key={b.id}
              className={`flyer-box ${b.status}`}
              title={b.error || (b.status === 'done' ? 'Queued for Review' : b.status)}
              style={{ left: `${b.box.x * 100}%`, top: `${b.box.y * 100}%`, width: `${b.box.w * 100}%`, height: `${b.box.h * 100}%` }}
            />
          ))}
          {live && (
            <span
              className="flyer-box drawing"
              style={{ left: `${live.x * 100}%`, top: `${live.y * 100}%`, width: `${live.w * 100}%`, height: `${live.h * 100}%` }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
