// 📷 Photo mode (BUSINESS_RULES §15): snap a shelf label in-store, review
// later. The photo is compressed client-side and uploaded to Firebase Storage
// (photos/{uid}/{id}.jpg); a queue entry is appended to db.photoQueue with
// status 'pending'. The daily processing job (scripts/photos/process.mjs,
// Claude Haiku vision) fills in the extracted fields, flips the status to
// 'ready' and deletes the photo — Storage never accumulates images.

import { getStorage, ref, uploadBytes, deleteObject, getDownloadURL } from 'firebase/storage'
import { app, auth } from './firebase'
import { uid } from './db'

const storage = getStorage(app)

// Downscale + re-encode to a small JPEG (~100-300 KB): plenty for the LLM to
// read a price label, tiny enough to upload on supermarket wifi.
async function compress(file, maxDim = 1400, quality = 0.72) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
  if (!blob) throw new Error('could not encode photo')
  return blob
}

// Compress + upload one photo and queue it for processing. Returns the queue id.
export async function addPhoto(update, file, storeId) {
  const id = uid('p')
  const path = `photos/${auth.currentUser.uid}/${id}.jpg`
  const blob = await compress(file)
  await uploadBytes(ref(storage, path), blob, { contentType: 'image/jpeg' })
  update((d) => {
    d.photoQueue ??= []
    d.photoQueue.push({ id, path, storeId: storeId ?? null, status: 'pending', ts: Date.now() })
  })
  return id
}

// Preview URL for a still-pending photo (processed entries have no photo left).
export function photoUrl(entry) {
  return getDownloadURL(ref(storage, entry.path))
}

// Remove a queue entry; best-effort delete of the photo if it still exists.
export function removePhoto(update, entry) {
  update((d) => {
    d.photoQueue = (d.photoQueue ?? []).filter((p) => p.id !== entry.id)
  })
  if (entry.status === 'pending' || entry.status === 'failed') {
    deleteObject(ref(storage, entry.path)).catch(() => {})
  }
}

// Entries awaiting the user: extracted and ready to approve, or failed.
// (The Review tab badge; 'pending' photos count too so the user knows
// something is in flight.)
export function reviewCount(db) {
  return (db.photoQueue ?? []).length
}
