import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

// Re-check for a new deploy every 5 min and whenever the app regains focus,
// so an installed PWA picks up updates without a full relaunch.
const updateSW = registerSW({
  onRegisteredSW(swUrl, reg) {
    if (!reg) return
    const check = () => reg.update().catch(() => {})
    setInterval(check, 5 * 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
    })
  },
  onNeedRefresh() {
    updateSW(true)
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
