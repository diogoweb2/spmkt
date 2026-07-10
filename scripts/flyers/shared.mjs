// Helpers shared by the weekly flyer import (run.mjs) and the meat
// classification pass (classify-meat.mjs): env loading, locating the claude
// CLI, and opening the shared family db doc in Firestore.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

export function loadEnv() {
  const envPath = join(here, '.env')
  if (!existsSync(envPath)) return {}
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  )
}

export function findClaude() {
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(homedir(), '.local/bin/claude')]) {
    if (existsSync(p)) return p
  }
  // Fall back to the binary bundled with the newest VSCode extension.
  const extDir = join(homedir(), '.vscode/extensions')
  const candidates = readdirSync(extDir)
    .filter((d) => d.startsWith('anthropic.claude-code-'))
    .sort()
  for (const d of candidates.reverse()) {
    const bin = join(extDir, d, 'resources/native-binary/claude')
    if (existsSync(bin)) return bin
  }
  throw new Error('claude CLI not found')
}

// The last JSON array in claude's output is the answer: it sometimes prints a
// draft, reconsiders, and prints a corrected array. Elements are flat-ish
// objects, so the last '[' before the last ']' is that array's start.
export function lastJsonArray(out) {
  const end = out.lastIndexOf(']')
  const start = out.lastIndexOf('[', end)
  if (start < 0 || end < start) throw new Error(`no JSON array in claude output:\n${out.slice(0, 500)}`)
  return JSON.parse(out.slice(start, end + 1))
}

// Opens the family db doc, preferring the service-account key (writes
// directly, no password) and falling back to family-password sign-in.
// Cached so callers share one Firebase app.
let familyDoc
export async function openFamilyDoc(env) {
  familyDoc ??= await connectFamilyDoc(env)
  return familyDoc
}

async function connectFamilyDoc(env) {
  const keyPath = join(here, 'service-account.json')
  if (existsSync(keyPath)) {
    const { initializeApp, cert } = await import('firebase-admin/app')
    const { getAuth } = await import('firebase-admin/auth')
    const { getFirestore } = await import('firebase-admin/firestore')
    const app = initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) })
    const user = await getAuth(app).getUserByEmail('family@smartprice.app')
    const ref = getFirestore(app).doc(`users/${user.uid}`)
    const snap = await ref.get()
    return { db: snap.exists ? snap.data() : null, save: (db) => ref.set(db) }
  }
  if (!env.FAMILY_PASSWORD) throw new Error('need scripts/flyers/service-account.json or FAMILY_PASSWORD in .env')
  const { initializeApp } = await import('firebase/app')
  const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth')
  const { getFirestore, doc, getDoc, setDoc } = await import('firebase/firestore')
  const app = initializeApp({
    apiKey: 'AIzaSyCVCDsMH1-cJ2rr_7o8WVBG26__Jl2bMXg',
    authDomain: 'spmkt-cc6fd.firebaseapp.com',
    projectId: 'spmkt-cc6fd',
  })
  const cred = await signInWithEmailAndPassword(getAuth(app), 'family@smartprice.app', env.FAMILY_PASSWORD)
  const ref = doc(getFirestore(app), 'users', cred.user.uid)
  const snap = await getDoc(ref)
  return { db: snap.exists() ? snap.data() : null, save: (db) => setDoc(ref, db) }
}
