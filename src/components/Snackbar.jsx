import { useEffect, useRef, useState } from 'react'
import { onToast } from '../lib/toast'

// Global snackbar host (one at a time, newest wins). Rendered once in App.
export default function Snackbar() {
  const [snack, setSnack] = useState(null)
  const timer = useRef(null)

  useEffect(() => {
    const off = onToast((s) => {
      clearTimeout(timer.current)
      setSnack(s)
      timer.current = setTimeout(() => setSnack(null), s.duration)
    })
    return () => { off(); clearTimeout(timer.current) }
  }, [])

  if (!snack) return null
  return (
    <div className="snackbar" role="status">
      <span>{snack.text}</span>
      {snack.undo && (
        <button
          onClick={() => {
            clearTimeout(timer.current)
            setSnack(null)
            snack.undo()
          }}
        >
          UNDO
        </button>
      )}
      <button aria-label="Dismiss" style={{ fontWeight: 400 }} onClick={() => setSnack(null)}>✕</button>
    </div>
  )
}
