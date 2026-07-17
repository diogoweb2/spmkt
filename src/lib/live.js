// ⚡ Photo Live (BUSINESS_RULES §15a): snap ONE shelf label and extract it on
// the spot with a vision model over OpenRouter (Gemini Flash-Lite — cheap,
// fast label OCR), then confirm/edit in a modal and save immediately. No
// Storage upload, no review queue, no daily job — the compressed photo goes
// straight to the API as a data URL so the price is usable in-store. The API
// key is stored in the family db (db.openrouterKey, Settings → Import), never
// in the repo or the deployed bundle.

import { compress } from './photos'
import { uid } from './db'
import { GROCERY_TYPES } from './meat'

const MODEL = 'google/gemini-2.5-flash-lite'
const UNITS = ['kg', 'g', 'lb', 'oz', 'L', 'ml', 'un']

export function liveEnabled(db) {
  return !!(db.openrouterKey ?? '').trim()
}

// Same extraction rules as the batch job (scripts/photos/process.mjs), for a
// single photo returning a single JSON object.
const PROMPT = (existingNames) => `This is a photo of ONE supermarket product / shelf price label, taken by a shopper. Extract the price entry:
- name: the product name. IMPORTANT: if the product matches one of the user's existing items below, return that EXACT existing name (so its price history continues); otherwise a clean generic name (brand + product, no marketing fluff).
- price: the shelf price in dollars (number). If a discount/sale price is shown, use it.
- qty and unit: what the price buys. unit must be one of ${JSON.stringify(UNITS)}.
  * price per lb/kg label -> qty 1, unit "lb"/"kg".
  * package with printed weight/volume (750 g, 2 L...) -> qty = that amount, unit g/kg/ml/L.
  * priced by piece with NO weight printed -> qty = piece count, unit "un". NEVER invent a weight.
- category: "meat" for meat/poultry/fish/seafood (fresh, frozen or processed), else "other".
- Meat only — frozen (true/false), bones (true/false), skin (true/false), best guess from the photo/product; processing: "natural" for whole/raw cuts, "ultra" for nuggets/sausages/bacon/deli/breaded/marinated.
- Non-meat only — groceryType: one of ${JSON.stringify(GROCERY_TYPES)} (supermarket section).
- note: anything important you could read that doesn't fit the fields (multi-buy conditions, member price...), else omit.
- If the photo is unreadable or shows no price, return {"error": "<short reason>"}.

The user's existing items: ${JSON.stringify(existingNames)}

Output ONLY a JSON object (no prose, no markdown fence).`

// Extract one shelf-label photo into a ready photoQueue-shaped entry
// (without queuing it). Throws with a human-readable reason on any failure.
export async function extractLive(db, file, storeId) {
  const key = (db.openrouterKey ?? '').trim()
  if (!key) throw new Error('No OpenRouter API key — add it in Settings → Import.')

  const blob = await compress(file)
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result)
    r.onerror = () => rej(new Error('could not read the photo'))
    r.readAsDataURL(blob)
  })

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': location.origin,
      'X-Title': 'Smart Price',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT((db.items ?? []).map((i) => i.name)) },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`OpenRouter error ${resp.status}: ${body.slice(0, 200) || resp.statusText}`)
  }
  const content = (await resp.json()).choices?.[0]?.message?.content ?? ''
  const m = String(content).match(/\{[\s\S]*\}/)
  if (!m) throw new Error('The model returned no extraction.')
  let r
  try {
    r = JSON.parse(m[0])
  } catch {
    throw new Error('Could not parse the extraction.')
  }
  if (r.error) throw new Error(String(r.error))
  if (!r.name || !(r.price > 0)) throw new Error('Could not read a product + price.')
  if (!(r.qty > 0) || !UNITS.includes(r.unit)) throw new Error('Could not read the quantity/unit.')

  const meat = r.category === 'meat'
  const itemName = String(r.name)
  const match = (db.items ?? []).find((i) => i.name.toLowerCase() === itemName.toLowerCase())
  const entry = {
    id: uid('p'),
    path: null, // never uploaded — nothing in Storage
    storeId: storeId ?? null,
    status: 'ready',
    ts: Date.now(),
    itemName,
    matchedItemId: match?.id ?? null,
    price: Math.round(Number(r.price) * 100) / 100,
    qty: Number(r.qty),
    unit: r.unit,
    category: meat ? 'meat' : 'other',
    ...(meat
      ? {
          frozen: !!r.frozen,
          bones: !!r.bones,
          skin: !!r.skin,
          processing: r.processing === 'ultra' ? 'ultra' : 'natural',
        }
      : { groceryType: GROCERY_TYPES.includes(r.groceryType) ? r.groceryType : 'other' }),
  }
  if (r.note) entry.note = String(r.note)
  return entry
}
