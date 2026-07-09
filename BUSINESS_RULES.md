# Smart Price — Business Rules

> **⚠️ Process rule:** This document is the source of truth for app behavior.
> Before implementing ANY business-logic change, read this document first.
> After implementing ANY business-logic change, update this document in the same change.

Code references: `src/lib/units.js` (units/normalization), `src/lib/analysis.js` (verdicts, comparisons), `src/lib/db.js` (data model).

---

## 1. Data model

Stored in Firestore (project `spmkt-cc6fd`): each user's entire db is a single document `users/{uid}`, same shape as the old localStorage db. Security rules allow access only to the doc's owner. The app live-syncs via a snapshot listener, so edits on one device appear on others. On first sign-in, any phase-1 localStorage db (`smartprice-db-v1`) is migrated up, then removed locally. No offline support (by decision, for now).

| Entity | Fields | Notes |
|---|---|---|
| **Store** | `id, name, color, defaultUnit` | Preloaded: Costco (kg), Walmart (lb), No Frills (lb). User can add/rename stores and change their default unit. |
| **Item** | `id, name, category, kind, defaultUnit, annualQty` | `category`: `meat` or `other` (legacy items may have `dairy`/`produce`/`pantry` — still valid). `kind`: `weight` \| `volume` \| `count`, derived from the unit chosen when the item was created. `annualQty`: user-set yearly consumption in base units, `null` = use default. |
| **Record** (price entry) | `id, itemId, storeId, price, qty, unit, frozen, bones, skin, ts` | `frozen/bones/skin`: booleans for meat, `null` for non-meat. `ts` is set automatically at save time — **the app never asks for a date**. |
| **Note** (bug/idea) | `id, type, text, done, ts` | `type`: `bug` \| `idea`. Personal todo list, see §11. |

- **Prices are append-only.** Updating a price creates a new record; history is never overwritten. Records can be individually deleted (with confirmation).
- **Auth**: one shared family password. The app signs everyone into a single Firebase Auth email/password account (`family@smartprice.app`); the password is stored hashed in Firebase Auth and is changed from the Firebase console. Same account ⇒ one shared household db. Asked once per device (Firebase Auth session persists); Settings offers "Lock app". The phase-1 PIN is retired (`pinHash` dropped during migration).

## 2. Units & normalization

- Supported units: `kg, g, lb, oz` (weight) · `L, ml` (volume) · `un` (count). Conversions: 1 lb = 453.592 g, 1 oz = 28.3495 g.
- **All comparison math normalizes internally to price per 100 g (weight), per 100 ml (volume), or per unit (count).** This makes 6 L milk bags vs 2 L cartons, and 1 kg vs 500 g cereal, directly comparable.
- An item's `kind` is fixed at creation; later entries for the item may only use units of the same kind.

### Display units (what the user sees)
- Weight prices display as **$/lb or $/kg** (global toggle, top-right of Items list and product page; persisted as `db.displayWeightUnit`, default `lb`). Volume displays as **$/L**, count as **$/unit**.
- Display is conversion-only; all logic still runs on normalized per-100g/100ml values.

### Default unit & quantity when adding a price
Priority order: last unit/qty used for **this item at this store** → last unit/qty for this item anywhere → item's default unit → store's default unit.

## 3. Meat variations

- Category `meat` adds three toggles when logging: **Fresh/Frozen**, **Bones Y/N**, **Skin Y/N**.
- The triple **(skin, bones, frozen) is a "variant"** — each variant is treated as a separate product: its own history, verdicts, store comparison, monthly chart, and list row.
- Variant display label format: `(skin-on|skinless, bone-in|boneless, fresh|frozen)` — shown after the item name in lists, and as tabs on the product page when an item has multiple variants.
- New-price toggles prefill from the item's most recent record. Legacy/non-meat records (all three fields `null`) form a single unlabeled "standard" variant.

## 4. Price verdict (shown after saving)

Compared **only against other records of the same item + variant**, using normalized prices:

| Verdict | Condition |
|---|---|
| ✅ First price saved | no other records for this variant |
| 🎉 Best price yet | ≤ best × 1.02 |
| 👍 Good deal | ≤ best × 1.10 |
| 😐 Average | ≤ median |
| ❌ Expensive | > median (message says where it was cheaper and by how much) |

## 5. "Where it's cheapest" (per product)

- One row per store: that store's **latest** record for the item+variant, ranked by normalized price. 🏆 marks the cheapest.
- Rows are tappable: **pick any two prices** to compare — the Yearly impact card then compares exactly those two. A third tap replaces the older selection; switching variant tabs clears the selection.

## 6. Yearly impact (savings projection)

- `savings/year = (expensive_norm − cheap_norm) × annualQty / 100` (per-unit items: ÷1).
- Which pair: user-picked pair if two prices are selected; otherwise max of (latest vs best-ever) and (best store vs worst store, latest prices).
- **Annual consumption**: defaults for a family of 4 by category/kind (meat 80 kg, dairy volume 250 L, dairy weight 30 kg, produce 100 kg, other weight 40 kg, other volume 100 L, count 52/yr). A slider lets the user override; the override is saved per item (`annualQty`) and always wins.
- Card hidden when computed savings ≤ $1 and no pair is picked.

## 7. Cheapest time of year (monthly chart)

- Product page shows average normalized price per **calendar month (Jan–Dec), aggregated across years**, per variant — to reveal seasonal lows for bulk buying.
- Shown only when the variant has records in ≥ 2 distinct calendar months. Cheapest month is highlighted and direct-labeled; caption names it ("Jul is usually cheapest — good month to stock up"). Tap a bar → that month's average + record count.

## 8. Multi-product comparison (⚖️ Compare)

- Entry: "⚖️ Compare" button on the Items tab (visible when ≥ 2 items have records). User taps items to select (search allowed); tray at bottom shows selections; "Compare (n)" enabled at ≥ 2.
- **Only same-kind products can be compared** (weight with weight, volume with volume); incompatible rows are dimmed and unselectable. Variants count as separate products.
- **The report uses each store's LATEST price per product only — never older records.**
- Report sections:
  1. **Winner banner** — most cost-effective product overall and at which store.
  2. **Best mix** — each product at its cheapest current store, ranked, with `+X%` vs the winner.
  3. **"If you shop at [store]"** — one card per store carrying ≥ 2 of the compared products, ranked using only that store's latest prices; products missing at that store are listed as having no price there.

## 9. Items list

- One row per **item + variant**, full variation name spelled out (never truncated), sorted by most recent record.
- Each row shows: record count, current cheapest store, and best-ever price in display units.

### Adding prices from the Items list ("current store")
- The app remembers **where the user is** (`db.currentStoreId`): set when a store is tapped on Home, when a store is created, or when picked in the "Where are you?" dialog. It stays until the user changes it (📍 chip on the Items tab → "change").
- Every item row has a **+** button → logs a new price for that item at the current store (form prefilled from the item's last record).
- If the search has no exact match, an **"+ Add '<term>' with a price"** button creates the product and logs its first price in one flow.
- If no current store is set, either action first asks "Where are you?" (store list); the choice is remembered.

## 10. Home screen

- Grid of store buttons only (no recent list). Known chains show their bundled logo on a white chip over the brand color (`src/lib/logos.js`, matched loosely by name); unknown stores show their name. Each button shows its logged-price count. "+ Add store" creates a store (default unit lb) and jumps straight into logging a price there.

## 11. Bugs & ideas (Settings)

- A todo list inside Settings (`src/components/Notes.jsx`) for logging **bugs 🐞** and **ideas 💡** while using the app.
- A note is `{id, type, text, done, ts}`; `ts` is set at save time. Stored in `db.notes`, so it syncs across devices and is included in the JSON export.
- Add: pick type (bug/idea), type the text, Add (or Enter). Rows can be checked off (`done`, shown struck through) or deleted (with confirmation).
- Filters: **Open** (default) · 🐞 Bugs · 💡 Ideas · Done. Bug/Idea filters show open notes of that type only. Sorted newest first; the heading shows the open count.

## 12. Roadmap (agreed, not yet built)

- ~~Phase 2: Firebase (auth + Firestore sync)~~ — **done (2026-07)**: Google auth, Firestore db, Hosting, GitHub auto-deploy (`.github/workflows/deploy.yml`, pushes to `main` on github.com/diogoweb2/spmkt). Notifications and offline data intentionally left out.
- Phase 3: photo of shelf label → AI API → structured JSON entry.
- Phase 4: weekly-flyer search per product.
