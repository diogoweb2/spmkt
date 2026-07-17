// Light is the app default; the dark theme is a per-device preference
// (localStorage, not the synced db) toggled in Settings → Appearance.

const KEY = 'sp-theme'

export function currentTheme() {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(KEY, theme)
  // Keep the browser chrome (PWA status bar) in sync with the surface color.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = theme === 'dark' ? '#101410' : '#f7f9f3'
}

export function initTheme() {
  applyTheme(currentTheme())
}
