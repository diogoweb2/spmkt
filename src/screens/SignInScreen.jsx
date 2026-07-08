import { useState } from 'react'
import { signIn } from '../lib/firebase'

export default function SignInScreen() {
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function go(e) {
    e.preventDefault()
    if (!pass) return
    setBusy(true)
    setError('')
    try {
      await signIn(pass)
    } catch (e2) {
      setError(e2.code === 'auth/too-many-requests'
        ? 'Too many attempts — wait a bit and try again.'
        : 'Wrong password, try again.')
      setBusy(false)
    }
  }

  return (
    <div className="pin-screen">
      <div className="pin-logo">🛒</div>
      <h1>Smart Price</h1>
      <p className="muted" style={{ marginTop: 6 }}>Enter the family password.</p>
      <p className="muted small" style={{ marginTop: 4 }}>
        You'll only be asked once on this device.
      </p>

      <form onSubmit={go} style={{ width: '100%', maxWidth: 320, marginTop: 16 }}>
        <input
          type="password"
          autoFocus
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="Family password"
          style={{ width: '100%', padding: 12, fontSize: 16, textAlign: 'center' }}
        />
        <p className="pin-error">{error}</p>
        <button className="btn" type="submit" disabled={busy || !pass} style={{ width: '100%' }}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
