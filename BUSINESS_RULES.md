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
| **Item** | `id, name, category, kind, defaultUnit, annualQty` (+ `meatType, processing, market` on meat) | `category`: `meat` or `other` (legacy items may have `dairy`/`produce`/`pantry` — still valid). `kind`: `weight` \| `volume` \| `count`, derived from the unit chosen when the item was created. `annualQty`: user-set yearly consumption in base units, `null` = use default. Meat classification fields: see §13. |
| **Record** (price entry) | `id, itemId, storeId, price, qty, unit, frozen, bones, skin, ts` (+ `source, validUntil` on flyer imports) | `frozen/bones/skin`: booleans for meat, `null` for non-meat. `ts` is set automatically at save time — **the app never asks for a date**. Flyer-imported records (§12) add `source: 'flyer'` and `validUntil`. |
| **Note** (bug/idea) | `id, type, text, done, ts` | `type`: `bug` \| `idea`. Personal todo list, see §11. |
| **Ignored** | `id, name, ts` | A product type the user never wants imported, see §9. |

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

### By-piece meat prices (reference-only records)
Supermarkets increasingly price meat by piece with no weight printed ("boneless skinless chicken breast, 3 piece — $8"), which makes comparison impossible by design.

- Such a price is stored **honestly as `un`** (qty = number of pieces) even on a `weight` item — the app/import never guesses a weight.
- A record whose unit kind ≠ its item's kind is **reference-only**: kept in history, but excluded from every comparison (verdict, best-ever, latest, where-it's-cheapest, monthly chart, ⚖️ compare). `isComparable(item, rec)` in `src/lib/analysis.js` is the single source of that rule; `recordNorm(rec, item)` returns `null` for them.
- UI: history shows `$8.00 / 3 units` with the caption "no weight — reference only"; the Items row shows the by-piece price under a "by piece" label; a product with only by-piece prices can't be selected for ⚖️ Compare. Saving one from AddPrice shows a warning and skips the verdict banner.
- AddPrice offers `un` alongside kg/lb/g/oz for **meat** items (only meat is sold this way).

### Simple meat entry (label price) & Costco package discounts
- **Label mode (default for meat in AddPrice):** the user types the price straight off the shelf label as **$/kg or $/lb** — no quantity field is shown, qty is saved as 1. Unit choices are `kg / lb / un`; choosing `un` reveals a "Pieces" field (by-piece entry, above).
- **Package mode (Costco only):** Costco meat packages often carry a "−$x off" sticker on a package priced by total weight. When the store's name contains "costco" (case-insensitive) and the item is meat, a "Price type" toggle appears: 🏷️ Label price / 📦 Package −$ off. Package mode asks for **package total price, discount sticker ($ off), and weight** (kg/lb/g/oz); the saved record is a normal weight record with `price = total − discount` (rounded to cents) and `qty` = the weight. A live caption shows the effective $/unit before saving.

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

### Merging duplicate products (`src/lib/merge.js`)
- **Hold** any row → merge mode. Tap rows to select; selection is **per item** (all its variants at once). Only same-`kind` items can be selected together (others are dimmed). "🔗 Merge (n)" enabled at ≥ 2.
- A dialog asks for the **final name**, prefilled with the name of the item having the most records (ties → shorter name), and lists what will happen. Confirm or edit.
- Merge keeps the **first-selected item's id**, moves every record of the others onto it, and deletes them. **No price is ever lost**; all history and variants survive.
- Field merge rules: `name` = user's choice · `category` = `meat` if any is meat, else the first non-`other` · `annualQty` = largest explicit value, `null` if none · `kind` must already match.
- **Unit normalization**: if the merged records use mixed units of one kind, all comparable records are rewritten to one unit — the first **present** among `lb, kg, g, oz` (weight) / `L, ml` (volume). Price is unchanged, `qty` is converted (rounded to 3 decimals) and becomes the item's `defaultUnit`. By-piece `un` records (§3) keep their unit — the app never invents a weight.

### Delete & ignore (`src/lib/ignore.js`)
- Same hold-to-select mode: with ≥ 1 product selected, "🚫 Delete & ignore" deletes those items **and all their prices** (confirmation dialog; not undoable) and appends their names to `db.ignored` = `{id, name, ts}`.
- The stored name is an **example, not a pattern**. The weekly flyer import passes the ignored names to Claude, which identifies each one's **generic product type** (brand, size and qualifiers dropped) and skips every flyer product of that type: ignoring "Royale Bathroom Tissue" skips all bathroom tissue; "Robin Hood All Purpose Flour" skips flour of every brand and variety **but keeps other Robin Hood products**; "Farmer's Market Pies" skips all pies. Genuinely different products sharing a brand, a word or a shelf are kept (paper towels ≠ bathroom tissue, cheesecake ≠ pie).
- `run.mjs` also drops products whose name matches an ignored name exactly (case-insensitive) as a backstop, so an ignored item is never re-created.
- Settings lists the ignored products with a "Stop ignoring" button (which does not restore the deleted prices).

### Adding prices from the Items list ("current store")
- The app remembers **where the user is** (`db.currentStoreId`): set when a store is tapped on the Location tab, when a store is created, or when picked in the "Where are you?" dialog. It stays until the user changes it (📍 chip on the Items tab → "change").
- Every item row has a **+** button → logs a new price for that item at the current store (form prefilled from the item's last record).
- If the search has no exact match, an **"+ Add '<term>' with a price"** button creates the product and logs its first price in one flow.
- If no current store is set, either action first asks "Where are you?" (store list); the choice is remembered.

## 10. Home & Location screens

- **Home** (🏠 tab) is the **Meat deals** page (§13). When there are no qualifying deals it shows an empty state explaining deals come from the weekly flyer import.
- **Location** (📍 tab, "Where are you?") holds the store grid. Known chains show their bundled logo on a white chip over the brand color (`src/lib/logos.js`, matched loosely by name); unknown stores show their name. Each button shows its logged-price count; tapping a store sets `currentStoreId` and opens price logging there. "+ Add store" creates a store (default unit lb) and jumps straight into logging a price there.

## 11. Bugs & ideas (Settings)

- A todo list inside Settings (`src/components/Notes.jsx`) for logging **bugs 🐞** and **ideas 💡** while using the app.
- A note is `{id, type, text, done, ts}`; `ts` is set at save time. Stored in `db.notes`, so it syncs across devices and is included in the JSON export.
- Add: pick type (bug/idea), type the text, Add (or Enter). Rows can be checked off (`done`, shown struck through) or deleted (with confirmation).
- Filters: **Open** (default) · 🐞 Bugs · 💡 Ideas · Done. Bug/Idea filters show open notes of that type only. Sorted newest first; the heading shows the open count.

## 12. Weekly flyer import (local job)

- `scripts/flyers/run.mjs`, scheduled by launchd (`com.spmkt.flyers`, Thursdays 8:00) on Diogo's Mac. Logs to `~/Library/Logs/spmkt-flyers.log`.
- For each supermarket in `scripts/flyers/stores.json`, it downloads **page 1 only** of the flyer from flyers-on-line.com — page 1 is the **first page image in document order**, not `_01.jpg`: the numeric suffix is not the display order (Superstore's page 1 is `_07.jpg`, `_01.._06` being ad inserts) — has Claude (headless CLI) read the image, and appends the extracted deals to the family Firestore doc. The downloaded image is deleted afterwards.
- Extraction rules: multi-product deals are split into one record per product; meat items get inferred `frozen`/`bones`/`skin` variant flags; per-lb / per-kg / package sizes map to the normal qty+unit model; "2 for $5" → unit price.
- The extraction prompt is given the db's existing item names and told to reuse the exact name when a flyer product matches, so price history continues instead of near-duplicate items being created. Items are then matched by case-insensitive name, otherwise created (`category` meat/other, `kind` from the unit). The store is matched by name or created.
- Flyer records carry `source: 'flyer'`, `ts` = import time, and `validUntil` = end of the flyer's last valid day (parsed from the site's "Valid from … to …" text; `null` if not found). Dedupe: at most one flyer record per item+store per 7 days (variant excluded: extraction can vary run to run).
- **A store whose flyer was already imported within the last 7 days is skipped before downloading** (no image fetch, no Claude call). `--force` re-imports anyway; `--dry-run` extracts without saving.
- **The import never invents a weight**: by-piece deals become `un` records (see §3).
- Only **groceries** are imported. Non-grocery flyer content (toys, clothing, kitchenware, pet food, diapers, points-only promos, event ads) is ignored. Products the user deleted & ignored (§9) are skipped by product type.
- Claude occasionally prints a draft array, reconsiders, and prints a corrected one: the extractor parses the **last** JSON array in the output.
- **Packaged/boxed products (frozen meat boxes, tubs, etc.) are recorded by printed package size** (e.g. 750 g, 1.1 kg), not as 1 unit — so a small FreshCo box is comparable with a big Costco box via the normal per-100g math.
- **UI**: records with a flyer source show a 📰 badge next to the product name (Items list, product page title) and in history rows — green "flyer until \<date\>" while valid, amber "flyer ended \<date\>" after. Expired flyer prices stay in the db as reference.
- Auth: prefers a Firebase admin service-account key at `scripts/flyers/service-account.json` (writes directly, bypassing security rules); falls back to signing in with `FAMILY_PASSWORD` from `scripts/flyers/.env`. Both files are gitignored.

## 13. Meat deals (Home) & LLM meat classification

Code: `src/lib/meat.js` (grouping + ratings), `scripts/flyers/classify-meat.mjs` (LLM pass), Home's `MeatDeals`.

### Item classification fields (meat items only)
- `meatType`: `beef` \| `pork` \| `chicken` \| `fish` \| `other` (fish = all seafood; turkey/lamb/duck/mixed → `other`). `null` until classified.
- `processing`: `natural` (whole/raw cuts: steaks, roasts, ground, raw pieces, fillets) or `ultra` (ultra-processed/prepared: nuggets, breaded, sausages, hot dogs, bacon, deli, burgers, marinated ready-meals, canned). **Manually added meat items default to `natural`**; flyer-created items start `null`.
- `market`: `{ excellent, good, avg, updatedAt }` — Toronto supermarket price thresholds in **CAD $/lb, using prices since Jan 2026 only** (meat prices rose sharply after the Iran war; older prices are misleading), researched by LLM web search (we don't yet have enough own history; may later be replaced by our own data). `excellent ≤ good ≤ avg` is enforced.
- On merge (§9), the first selected item that has each field wins.

### Classification pass (`classify-meat.mjs`)
- Runs automatically at the **end of every weekly flyer import** (`run.mjs`), and can run standalone (`--all` reclassifies everything, `--dry-run` doesn't save).
- Classifies meat items with any field missing and refreshes `market` older than 6 days, in one Claude (headless, WebSearch-enabled) call; matches results back by case-insensitive name and validates enums/thresholds before saving.

### Meat deals section (Home)
- Groups: **Beef, Pork, Chicken, Fish, Other meat** (unclassified meat falls under Other). Per meat type, `natural` items form one section and `ultra` items form a separate **"<Type> · ultra-processed"** section right after it (no per-row ultra-processed chip). Empty sections are hidden.
- One row per meat item: its current best deal = cheapest of each store's **latest non-expired comparable** record. **Expired flyer prices (`validUntil` in the past) are never shown**; records without `validUntil` (manual entries) never expire. By-piece records are excluded (§3).
- Row shows: item name, `cheapest @ <store>` (+ `until <date>` for flyer deals), price in display units, and a deal rating badge vs `market` ($/lb): ≤ excellent → **🔥 Excellent deal**, ≤ good → **👍 Good deal**, ≤ avg → average, else bad. Items with no market data yet still show, without a badge. Tapping a row opens the product page.
- **Filters (multiselect chips above the list):** by deal rating, meat type + processing (Natural/Ultra-processed, one row; only types that currently have deals get a chip; all on by default), and by store. Rating filter defaults to **excellent + good** (so Home shows real deals by default; average/bad can be opted in). Store chips list the stores that currently have deals, all selected by default (a row shows only if its store chip is on **and** its rating chip is on); the store chip row is hidden when only one store has deals, and starts with a ✕ chip that deselects all stores (to quickly pick just one). Items with no market data always pass the rating filter. Filters reset on reload (not persisted).

## 14. Roadmap (agreed, not yet built)

- ~~Phase 2: Firebase (auth + Firestore sync)~~ — **done (2026-07)**: Google auth, Firestore db, Hosting, GitHub auto-deploy (`.github/workflows/deploy.yml`, pushes to `main` on github.com/diogoweb2/spmkt). Notifications and offline data intentionally left out.
- Phase 3: photo of shelf label → AI API → structured JSON entry.
- Phase 4: weekly-flyer search per product.
