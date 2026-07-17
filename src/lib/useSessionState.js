import { useEffect, useState } from 'react'

// useState persisted in sessionStorage, so screen state (filters, tabs)
// survives navigating away and back within the browser session. Pass
// { set: true } for Set values (stored as arrays).
export default function useSessionState(key, init, { set = false } = {}) {
  const [val, setVal] = useState(() => {
    try {
      const raw = sessionStorage.getItem(key)
      if (raw != null) {
        const parsed = JSON.parse(raw)
        return set ? new Set(parsed) : parsed
      }
    } catch {
      /* corrupt/unavailable storage — fall through to default */
    }
    return typeof init === 'function' ? init() : init
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(set ? [...val] : val))
    } catch {
      /* storage full/unavailable — state still works in-memory */
    }
  }, [key, val, set])
  return [val, setVal]
}
