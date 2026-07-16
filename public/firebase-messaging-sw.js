/* global importScripts, firebase */
// Firebase Cloud Messaging background handler. Separate from the Workbox PWA
// service worker (it registers on its own scope, /firebase-cloud-messaging-push-scope).
// Sends carry a webpush.notification payload, so FCM displays them automatically;
// onBackgroundMessage below is a fallback for any data-only messages.
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js')

firebase.initializeApp({
  apiKey: 'AIzaSyCVCDsMH1-cJ2rr_7o8WVBG26__Jl2bMXg',
  authDomain: 'spmkt-cc6fd.firebaseapp.com',
  projectId: 'spmkt-cc6fd',
  storageBucket: 'spmkt-cc6fd.firebasestorage.app',
  messagingSenderId: '135441406704',
  appId: '1:135441406704:web:a16e9f5b942c0b87820035',
})

const messaging = firebase.messaging()

messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || payload.data || {}
  self.registration.showNotification(n.title || 'Smart Price', {
    body: n.body || '',
    icon: '/favicon.svg',
  })
})
