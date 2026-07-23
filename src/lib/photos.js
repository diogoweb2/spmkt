// 📷 Photo mode (BUSINESS_RULES §15): snap a shelf label in-store, review
// later. The photo is compressed client-side and uploaded to Firebase Storage
// (photos/{uid}/{id}.jpg); a queue entry is appended to db.photoQueue with
// status 'pending'. The daily processing job (scripts/photos/process.mjs,
// Claude Haiku vision) fills in the extracted fields, flips the status to
// 'ready' and deletes the photo — Storage never accumulates images.

import { getStorage, ref, uploadBytes, deleteObject, getDownloadURL } from 'firebase/storage'
import { app, auth } from './firebase'
import { uid } from './db'
import { unitKind } from './units'
import { guessMeatType } from './meat'
import { findByName } from './merge'

const storage = getStorage(app)

// Downscale + re-encode to a small JPEG (~100-300 KB): plenty for the LLM to
// read a price label, tiny enough to upload on supermarket wifi.
export async function compress(file, maxDim = 1400, quality = 0.72) {
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

// Best-effort delete of an entry's Storage image (pending photo capture, or a
// flyer review entry with its page image, §12). No-op when the entry has no
// path or the object is already gone (processed captures keep a dangling path).
export function deleteEntryImage(entry) {
  if (entry?.path) deleteObject(ref(storage, entry.path)).catch(() => {})
}

// Remove a queue entry; best-effort delete of its image if it still exists.
export function removePhoto(update, entry) {
  update((d) => {
    d.photoQueue = (d.photoQueue ?? []).filter((p) => p.id !== entry.id)
  })
  deleteEntryImage(entry)
}

// Apply an extracted entry (photo batch OR Photo Live) against the draft db:
// reuse the matched item or create it, append the record (ts = when the photo
// was taken, source 'photo'), drop the queue entry if it was queued. Must run
// inside update()'s mutate so a batch sees items created by earlier entries.
// Returns the item id (so Photo Live can navigate to the product page).
//
// `newId` pre-assigns the id used when the entry creates a new item. Callers
// that need the id *before* the state update lands (React defers update()'s
// mutator, so reading a value written inside it is a race) pass one from
// `entryItemId` below; it also keeps the result identical if React runs the
// mutator twice in StrictMode.
export function applyEntry(d, entry, newId = null) {
  const meat = entry.category === 'meat'
  let item =
    d.items.find((i) => i.id === entry.matchedItemId) ??
    findByName(d.items, d.records, entry.itemName)
  if (!item) {
    item = {
      id: newId ?? uid('i'),
      name: entry.itemName,
      category: meat ? 'meat' : 'other',
      kind: unitKind(entry.unit),
      defaultUnit: entry.unit,
      annualQty: null,
      meatType: meat ? guessMeatType(entry.itemName) : null,
      processing: meat ? (entry.processing ?? 'natural') : null,
      market: null,
      ...(meat ? {} : { groceryType: entry.groceryType ?? 'other' }),
    }
    d.items.push(item)
  }
  // Flyer-sourced review entries (§12: unsized `un` imports parked for the user
  // to add a weight) keep their flyer provenance — source, validity window and
  // the linked ad page — so an approved record is indistinguishable from a
  // direct flyer import. Everything else is a photo capture.
  const flyer = entry.source === 'flyer'
  d.records.push({
    id: uid('r'),
    itemId: item.id,
    storeId: entry.storeId,
    price: entry.price,
    qty: entry.qty,
    unit: entry.unit,
    frozen: meat ? !!entry.frozen : null,
    bones: meat ? !!entry.bones : null,
    skin: meat ? !!entry.skin : null,
    // Multi-buy price (§1): must buy N to get this per-item price.
    ...(Number.isInteger(entry.minQty) && entry.minQty >= 2 ? { minQty: entry.minQty } : {}),
    ...(flyer
      ? {
          ...(entry.origName && entry.origName.toLowerCase() !== item.name.toLowerCase() ? { origName: entry.origName } : {}),
          source: 'flyer',
          validUntil: entry.validUntil ?? null,
          flyerUrl: entry.flyerUrl ?? null,
          flyerPage: entry.flyerPage ?? null,
          ...(entry.upcoming ? { upcoming: true } : {}),
        }
      : {
          // Photographed into an existing group (the shelf name is one of its
          // members, or the user renamed): keep the shelf name on the record.
          ...(entry.itemName && entry.itemName.toLowerCase() !== item.name.toLowerCase()
            ? { origName: entry.itemName }
            : {}),
          source: 'photo',
        }),
    ts: entry.ts,
  })
  d.photoQueue = (d.photoQueue ?? []).filter((p) => p.id !== entry.id)
  return item.id
}

// The item id an entry will land on, resolved against the *current* db and
// known before applyEntry runs: the matched/existing item, or a freshly minted
// id to hand applyEntry as `newId`. Lets a caller navigate to (or suggest
// merges for) the item without waiting for the state update to commit.
export function entryItemId(db, entry) {
  const existing =
    db.items.find((i) => i.id === entry.matchedItemId) ??
    findByName(db.items, db.records, entry.itemName)
  return existing?.id ?? uid('i')
}

// Entries awaiting the user: extracted and ready to approve, or failed.
// (The Review tab badge; 'pending' photos count too so the user knows
// something is in flight.)
export function reviewCount(db) {
  return (db.photoQueue ?? []).length
}
