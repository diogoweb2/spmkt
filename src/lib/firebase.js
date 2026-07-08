import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyCVCDsMH1-cJ2rr_7o8WVBG26__Jl2bMXg',
  authDomain: 'spmkt-cc6fd.firebaseapp.com',
  projectId: 'spmkt-cc6fd',
  storageBucket: 'spmkt-cc6fd.firebasestorage.app',
  messagingSenderId: '135441406704',
  appId: '1:135441406704:web:a16e9f5b942c0b87820035',
})

// Single shared family account: everyone signs in with the same password,
// which is stored (hashed) in Firebase Auth. Same account = same shared db.
const FAMILY_EMAIL = 'family@smartprice.app'

export const auth = getAuth(app)
export const firestore = getFirestore(app)

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb)
}

export function signIn(password) {
  return signInWithEmailAndPassword(auth, FAMILY_EMAIL, password)
}

export function signOutUser() {
  return signOut(auth)
}
