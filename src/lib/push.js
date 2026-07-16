// Web push (Firebase Cloud Messaging). enablePush() asks the browser for
// notification permission and returns an FCM device token; Settings stores it
// in the shared family db (db.pushTokens) so the weekly flyer job can notify
// every registered device when the import finishes.
//
// The FCM service worker (public/firebase-messaging-sw.js) is registered on its
// own scope so it coexists with the Workbox PWA service worker at '/'.
import { getMessaging, getToken, isSupported } from 'firebase/messaging'
import { app } from './firebase'

// Public "Web Push certificate" key pair from Firebase console → Project
// settings → Cloud Messaging. Safe to ship (it's the public half).
const VAPID_KEY = 'BFvaO8VXRJ9F_qK7S7c9iKoGUsqr9HRlJGm5c0-V7qJ1Fy1czZnf2W4Uqfn3DdkxmsJ0Am81Uj7VC3WpF_VfQ-4'
const FCM_SCOPE = '/firebase-cloud-messaging-push-scope'

export function pushSupported() {
  return isSupported().catch(() => false)
}

// Requests permission and returns the FCM token for this device, or throws a
// user-readable error. iOS only allows this in a Home-Screen-installed PWA.
export async function enablePush() {
  if (!(await isSupported())) throw new Error('This browser does not support push notifications.')
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.')
  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: FCM_SCOPE })
  const token = await getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg })
  if (!token) throw new Error('Could not get a device token. Try again.')
  return token
}
