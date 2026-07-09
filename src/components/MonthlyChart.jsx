import { useState } from 'react'
import { recordNorm } from '../lib/analysis'
import { fmtDisplay, displayUnitLabel } from '../lib/units'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Average normalized price per calendar month (across years), to reveal
// seasonal lows worth buying in bulk.
function monthlyAverages(recs, item) {
  const buckets = Array.from({ length: 12 }, () => ({ sum: 0, n: 0 }))
  for (const r of recs) {
    const norm = recordNorm(r, item)
    if (norm == null) continue
    const b = buckets[new Date(r.ts).getMonth()]
    b.sum += norm
    b.n++
  }
  return buckets.map((b) => (b.n ? { avg: b.sum / b.n, n: b.n } : null))
}

export default function MonthlyChart({ recs, item, kind, weightUnit }) {
  const [sel, setSel] = useState(null)
  const months = monthlyAverages(recs, item)
  const withData = months.filter(Boolean)
  if (withData.length < 2) return null // one month tells no seasonal story

  const max = Math.max(...withData.map((m) => m.avg))
  const min = Math.min(...withData.map((m) => m.avg))
  const minIdx = months.findIndex((m) => m && m.avg === min)

  const W = 344
  const H = 120
  const top = 22 // room for the direct label
  const axisH = 18
  const plotH = H - top - axisH
  const slot = W / 12
  const barW = slot - 4 // ≥2px surface gap on each side

  return (
    <div className="card">
      <h2>Cheapest time of year 📅</h2>
      <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
        Average price per month · {MONTHS[minIdx]} is usually cheapest — good month to stock up.
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={`Average price per month; cheapest in ${MONTHS[minIdx]}`}
      >
        {months.map((m, i) => {
          const x = i * slot + 2
          if (!m) {
            return (
              <line
                key={i}
                x1={x + barW / 2}
                x2={x + barW / 2}
                y1={top + plotH - 1}
                y2={top + plotH}
                stroke="var(--line)"
                strokeWidth={barW}
              />
            )
          }
          const h = Math.max(6, (m.avg / max) * plotH)
          const y = top + plotH - h
          const selected = sel === i
          return (
            <g key={i} onClick={() => setSel(selected ? null : i)} style={{ cursor: 'pointer' }}>
              {/* hit target wider than the mark */}
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              <path
                d={`M${x},${y + 4} a4,4 0 0 1 4,-4 h${barW - 8} a4,4 0 0 1 4,4 v${h - 4} h${-barW} z`}
                fill="var(--accent)"
                opacity={selected || i === minIdx ? 1 : 0.55}
              />
              {(i === minIdx || selected) && (
                <text
                  x={Math.min(Math.max(x + barW / 2, 16), W - 16)}
                  y={y - 7}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                  fill="var(--text)"
                >
                  {fmtDisplay(m.avg, kind, weightUnit).split(' / ')[0]}
                </text>
              )}
            </g>
          )
        })}
        {months.map((_, i) => (
          <text
            key={'l' + i}
            x={i * slot + slot / 2}
            y={H - 4}
            textAnchor="middle"
            fontSize="9"
            fill="var(--muted)"
          >
            {MONTHS[i][0]}
          </text>
        ))}
      </svg>
      <p className="muted small" style={{ marginTop: 8, minHeight: 18 }}>
        {sel != null && months[sel]
          ? `${MONTHS[sel]}: avg ${fmtDisplay(months[sel].avg, kind, weightUnit)} · ${months[sel].n} record${months[sel].n === 1 ? '' : 's'}`
          : `per ${displayUnitLabel(kind, weightUnit)} · tap a bar for details`}
      </p>
    </div>
  )
}
