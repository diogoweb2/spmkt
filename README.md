# Smart Price 🛒

A mobile-first PWA to know, right at the shelf, whether a grocery price is a good deal.

## Phase 1 (current) — manual input, local only

- **PIN lock**: create a 4-digit PIN on first launch; never asked again on that device (lock/change it in Settings).
- **Log a price in seconds**: tap the store → type or pick the product (autocomplete) → price + quantity + unit → save.
- **Instant verdict**: Best price yet / Good deal / Average / Expensive, compared against your own history.
- **Unit normalization**: kg, g, lb, oz, L, ml, unit — everything is compared per **100 g** (weight), **100 ml** (volume) or per unit, so 6 L milk bags vs 2 L cartons and 1 kg vs 500 g cereal compare fairly.
- **Where it's cheapest**: latest price per store, ranked.
- **Yearly impact**: projected yearly savings for a family of 4, with a slider to adjust your own consumption.
- **Fresh / frozen** toggle for meat.
- **Price history** per item — new prices are new records, never overwrites.
- **Stores**: Costco / Walmart / No Frills preloaded; add, rename, and set a default unit per store.
- **Backup**: JSON export/import in Settings (data lives in `localStorage` until Firebase).

## Run

```sh
npm install
npm run dev       # develop
npm run build     # production build (PWA with service worker)
npm run preview   # serve the build locally
```

## Architecture

- React + Vite + `vite-plugin-pwa` (installable, auto-updating service worker; online-first, no offline requirement).
- `src/lib/db.js` — data layer over `localStorage`, shaped to be swapped for Firebase later.
- `src/lib/units.js` — unit conversion / price normalization.
- `src/lib/analysis.js` — verdicts, cheapest-store ranking, yearly-savings projection.
- `src/screens/` — PinScreen, Home (store picker), AddPrice, ItemDetail, Items, Settings.

## Roadmap

- Phase 2: Firebase (auth + Firestore sync).
- Phase 3: photo of shelf label → AI API → structured price entry.
- Phase 4: weekly-flyer search per product.
