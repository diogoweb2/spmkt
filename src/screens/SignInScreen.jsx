import { useState } from 'react'
import { signIn } from '../lib/firebase'

export default function SignInScreen() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function go() {
    setBusy(true)
    setError('')
    try {
      await signIn()
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request')
        setError('Sign-in failed, try again.')
      setBusy(false)
    }
  }

  return (
    <div className="pin-screen">
      <div className="pin-logo">🛒</div>
      <h1>Smart Price</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        Sign in to keep your prices synced across your devices.
      </p>
      <p className="pin-error">{error}</p>
      <button className="btn" style={{ marginTop: 16 }} onClick={go} disabled={busy}>
        {busy ? 'Signing in…' : 'Continue with Google'}
      </button>
    </div>
  )
}
