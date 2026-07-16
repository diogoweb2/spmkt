import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  define: { __BUILD_DATE__: JSON.stringify(new Date().toISOString()) },
  server: { port: 5180, strictPort: true, host: true },
  preview: { port: 5181, strictPort: true, host: true },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The FCM background worker is its own service worker on a separate scope;
      // keep Workbox from precaching (and staling) it.
      workbox: { globIgnores: ['**/firebase-messaging-sw.js'] },
      manifest: {
        name: 'Smart Price',
        short_name: 'SmartPrice',
        description: 'Know if it is a good deal, right at the shelf.',
        theme_color: '#16a34a',
        background_color: '#f6f7f9',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
})
