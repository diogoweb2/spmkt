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
| **Item** | `id, name, category, kind, defaultUnit, annualQty` (+ `meatType, processing, market` on meat; `groceryType, market` on non-meat) | `category`: `meat` or `other` (legacy items may have `dairy`/`produce`/`pantry` — still valid). `kind`: `weight` \| `volume` \| `count`, derived from the unit chosen when the item was created. `annualQty`: user-set yearly consumption in base units, `null` = use default. Meat classification fields: see §13. `groceryType`: supermarket section for Home's Groceries filter, see §13. |
| **Record** (price entry) | `id, itemId, storeId, price, qty, unit, frozen, bones, skin, ts` (+ `source, validUntil, flyerUrl, flyerPage` on flyer imports; + `origName` when the record was logged under a different item name — set by merges and by the flyer import) | `frozen/bones/skin`: booleans for meat, `null` for non-meat. `ts` is set automatically at save time — **the app never asks for a date**. Flyer-imported records (§12) add `source: 'flyer'`, `validUntil`, `flyerUrl` and `flyerPage`. |
| **Note** (bug/idea) | `id, type, text, done, ts` | `type`: `bug` \| `idea`. Personal todo list, see §11. |
| **Ignored** | `id, name, ts` | A product type the user never wants imported, see §9. |
| **PhotoQueue entry** | `id, path, storeId, status, ts` (+ extracted fields when `ready`: `itemName, matchedItemId, price, qty, unit, category, frozen/bones/skin/processing` or `groceryType`, `note`; + `error` when `failed`) | 📷 photo mode, see §15. `status`: `pending` \| `ready` \| `failed`. `ts` = when the photo was taken (becomes the record's ts on approve). |
| **WhitelistRule** | `id, text, ts` | Plain-language keyword rule for the flyer-import whitelist (`db.whitelist`), see §12. `db.whitelistOn` toggles the feature. |

- **Prices are append-only.** Logging a price creates a new record; history is never overwritten. Records can be individually deleted (snackbar with Undo, §15b). Two explicit correction exceptions: (a) tapping a record in the product's History opens the **AddPrice form in edit mode**, prefilled with that record — price, quantity/weight, unit, package mode, fresh/frozen, bones/skin, plus the item's category and Natural/Ultra-processed — and "Save changes" **updates the record (and item classification) in place**; the record's date and store are not editable. (b) In store mode (§9), saving a **different** price for an item already logged at the current store asks "**📈 New price — add to history**" vs "**✏️ I typed it wrong before — fix it**"; the fix path overwrites that store's latest record in place. Saving the **same** price/qty/unit as that record is a no-op (snackbar, no record).
- **Auth**: one shared family password. The app signs everyone into a single Firebase Auth email/password account (`family@smartprice.app`); the password is stored hashed in Firebase Auth and is changed from the Firebase console. Same account ⇒ one shared household db. Asked once per device (Firebase Auth session persists); Settings offers "Lock app". The phase-1 PIN is retired (`pinHash` dropped during migration).

## 2. Units & normalization

- Supported units: `kg, g, lb, oz` (weight) · `L, ml` (volume) · `un` (count). Conversions: 1 lb = 453.592 g, 1 oz = 28.3495 g.
- **All comparison math normalizes internally to price per 100 g (weight), per 100 ml (volume), or per unit (count).** This makes 6 L milk bags vs 2 L cartons, and 1 kg vs 500 g cereal, directly comparable.
- An item's `kind` is fixed at creation; later entries for the item may only use units of the same kind.

### Display units (what the user sees)
- Weight prices display as **$/lb or $/kg** (persisted as `db.displayWeightUnit`, default `lb`; toggled top-right of Items list and product page, or via the global ⚖️ pill next to the 💳 pill above the bottom nav). Volume displays as **$/L**, count as **$/unit**.
- Display is conversion-only; all logic still runs on normalized per-100g/100ml values.

### Default unit & quantity when adding a price
Priority order: last unit/qty used for **this item at this store** → last unit/qty for this item anywhere → item's default unit → store's default unit.

### Card cashback (`src/lib/cashback.js`)
- Groceries are paid by card with cashback, so the **effective price is lower than the shelf price**: **5% (Amex)** at Metro, Food Basics, Sobeys, FreshCo, Longo's, Whole Foods Market and Farm Boy (matched loosely on the store name), **1.5% (Mastercard)** at every other store.
- When enabled (default), the cashback is baked into `recordNorm` (when passed `db`) and into displayed record prices (`effectivePrice`): **all shown prices AND all comparison math** — verdicts, where-it's-cheapest, yearly impact, monthly chart, ⚖️ Compare, Home deal ratings vs `market` — run on effective prices. A 5% store can genuinely beat a 1.5% store on the same shelf price.
- **Stored record prices stay raw** (the shelf price as entered/imported); the discount is applied at read time only. AddPrice inputs are shelf prices, and a live "💳 after x% cashback: $y/unit" caption shows how the entered price will be compared/displayed.
- Two toggles for the same `db.cashback` flag: Settings → "Card cashback 💳", and a **global 💳 on/off pill** fixed above the bottom nav (visible on every screen) to quickly flip between shelf and effective prices. Rates and the Amex store list are fixed in code.

## 3. Meat variations

### By-piece meat prices (reference-only records)
Supermarkets increasingly price meat by piece with no weight printed ("boneless skinless chicken breast, 3 piece — $8"), which makes comparison impossible by design.

- Such a price is stored **honestly as `un`** (qty = number of pieces) even on a `weight` (or `volume`) item — the app/import never guesses a weight. Though described here for meat, the flyer import applies the same rule to **any** product (§12).
- A record whose unit kind ≠ its item's kind is **reference-only**: kept in history, but excluded from every comparison (verdict, best-ever, latest, where-it's-cheapest, monthly chart, ⚖️ compare). `isComparable(item, rec)` in `src/lib/analysis.js` is the single source of that rule; `recordNorm(rec, item)` returns `null` for them.
- UI: history shows `$8.00 / 3 units` with the caption "no weight — reference only"; the Items row shows the by-piece price under a "by piece" label; a product with only by-piece prices can't be selected for ⚖️ Compare. Saving one from AddPrice shows a warning and skips the verdict banner.
- AddPrice offers `un` alongside kg/lb/g/oz for **meat** items (only meat is sold this way).

### Simple meat entry (label price) & Costco package discounts
- **Label mode (default for meat in AddPrice):** the user types the price straight off the shelf label as **$/kg or $/lb** — no quantity field is shown, qty is saved as 1. Unit choices are `kg / lb / un`; choosing `un` reveals a "Pieces" field (by-piece entry, above).
- **Package mode (any store, meat only):** for packages priced by total weight with no per-kg/per-lb label. For meat, a "Price type" toggle appears: 🏷️ Label price / 📦 Package price. Package mode asks for **package total price and weight** (kg/lb/g/oz); at stores whose name contains "costco" (case-insensitive) it also asks for a **discount sticker ($ off)** — Costco meat packages often carry a "−$x off" sticker. The saved record is a normal weight record with `price = total − discount` (rounded to cents) and `qty` = the weight. A live caption shows the effective $/unit before saving.
- **Processing (new meat items):** when creating a new meat item, a 🥩 Natural / 🌭 Ultra-processed toggle sets `processing` (default natural). Picking Ultra-processed also defaults Fresh/Frozen to **frozen** (Natural resets it to fresh); the user can still change it.

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
- **Second entry on Home:** long-press a deal row (≈450 ms) to enter compare mode, then tap more rows to select; same tray + report. Home selection is per **item** (variant-agnostic: the report compares all the item's records, latest per store).
- **Only same-kind products can be compared** (weight with weight, volume with volume); incompatible rows are dimmed and unselectable. Variants count as separate products.
- **The report uses each store's LATEST price per product only — never older records.**
- Report sections:
  1. **Winner banner** — most cost-effective product overall and at which store.
  1b. **"🚗 Worth the trip?" amount slider** — the user slides to the amount they plan to buy (0.5–30 in the display unit lb/kg or L, step 0.5; 1–50 for count items; default 5). Every `+X%` in the report then also shows the **total $ difference at that amount** (`+$Y / N lb`), and the card itself shows the winner's total cost for that amount plus how much more the priciest option would cost — so a small per-lb gap can be judged against the gas/effort of driving to another store. The amount is per-report, not persisted.
  2. **Best mix** — each product at its cheapest current store, ranked, with `+X%` vs the winner.
  3. **"If you shop at [store]"** — one card per store carrying ≥ 2 of the compared products, ranked using only that store's latest prices; products missing at that store are listed as having no price there.

## 9. All items view (Home) — the former Items tab

- One row per **item + variant**, full variation name spelled out (never truncated), sorted by most recent record.
- Each row shows: record count, current cheapest store, and best-ever price in display units.

> **The separate Items tab was removed (2026-07 redesign).** Home has a 🏷️ Deals / 📋 All items segmented switch; All items is the old Items list (one row per item+variant, search, per-row ➕ add-price, add-with-price). The Home search field filters both views.

### One selection mode (Compare · Merge · Don't import)
- Enter by **long-pressing** any row (Deals or All items view) or via a row's **⋮ menu** (⚖️ Compare with… / 🔗 Merge with… / 🚫 Don't import — the last one jumps straight to the confirm dialog for that single item).
- While selecting, a **contextual action bar** replaces the top bar: `✕ · n selected · ⚖️ Compare · 🔗 Merge · 🚫 Don't import`. No kind-based dimming — instead each action enables itself: Compare needs ≥ 2 same-`kind` comparable selections (by-piece-only rows never qualify), Merge needs ≥ 2 mergeable items, Don't import needs ≥ 1.
- Selection is per **item** in the Deals view (an item's normal + by-piece rows toggle together) and per **item+variant row** in All items (Compare compares variants; Merge/Don't import act on the underlying items).

### Merging duplicate products (`src/lib/merge.js`)
- A dialog asks for the **final name**, prefilled with the name of the item having the most records (ties → shorter name), and lists what will happen. Confirm or edit.
- Merge keeps the **first-selected item's id**, moves every record of the others onto it, and deletes them. **No price is ever lost**; all history and variants survive.
- **Original names survive a merge**: every merged record whose item name differs from the final name gets `origName` = the name it was logged under (set once — an existing `origName` is never overwritten by a later merge). ItemDetail's History shows it in italics under the store line, so a generically-named item can still be found on the shelf by its store-specific name.
- Field merge rules: `name` = user's choice · `category` = `meat` if any is meat, else the first non-`other` · `annualQty` = largest explicit value, `null` if none · `kind` must already match.
- **Unit normalization**: if the merged records use mixed units of one kind, all comparable records are rewritten to one unit — the first **present** among `lb, kg, g, oz` (weight) / `L, ml` (volume). Price is unchanged, `qty` is converted (rounded to 3 decimals) and becomes the item's `defaultUnit`. By-piece `un` records (§3) keep their unit — the app never invents a weight.

### Delete & ignore (`src/lib/ignore.js`)
- Same hold-to-select mode: with ≥ 1 product selected, "🚫 Delete & ignore" deletes those items **and all their prices** (confirmation dialog; not undoable) and appends their names to `db.ignored` = `{id, name, ts}`.
- The stored name is an **example, not a pattern**. The weekly flyer import passes the ignored names to Claude, which identifies each one's **generic product type** (brand, size and qualifiers dropped) and skips every flyer product of that type: ignoring "Royale Bathroom Tissue" skips all bathroom tissue; "Robin Hood All Purpose Flour" skips flour of every brand and variety **but keeps other Robin Hood products**; "Farmer's Market Pies" skips all pies. Genuinely different products sharing a brand, a word or a shelf are kept (paper towels ≠ bathroom tissue, cheesecake ≠ pie).
- `run.mjs` also drops products whose name matches an ignored name exactly (case-insensitive) as a backstop, so an ignored item is never re-created.
- Settings lists the ignored products with a "Stop ignoring" button (which does not restore the deleted prices).

### Store mode — adding & updating prices at the current store
- The app remembers **where the user is** (`db.currentStoreId`): set via the **📍 store chip** in Home's top bar (opens the "Where are you?" bottom sheet — the old Location tab, `src/components/StoreSheet.jsx`), when a store is created, or when the sheet is shown because an add action needed a store. It stays until changed.
- The **➕ FAB** (center of the mobile nav bar; top of the desktop rail) opens AddPrice at the current store; with no store set, the store sheet appears first.
- **AddPrice is search-first.** Result rows answer "did I already log this here?": items with a record at this store sort first and show `📍 here: $x/unit · date` with an **update** badge; others show their category and "never logged at <store>".
- Picking an item with a record at this store **prefills the entire form from that record — including the price** — plus a banner showing what was paid here, when, and the cheapest other store. Usually only the price needs a glance. Save behavior: same price = no-op; different price = "new vs correction" dialog (§1).
- Every All items row has a **+** button → logs a new price for that item at the current store; a search with no exact match offers **"+ Add '<term>' with a price"**. If no current store is set, either action shows the store sheet first.

## 9b. Navigation, layout & browser history (2026-07 redesign)

- **Three destinations + a FAB**: 🏠 Home · 📷 Review (badge = `db.photoQueue` size) · ⚙️ Settings, plus the center **➕ FAB** (§9). Mobile (<900px): M3 bottom navigation bar + floating FAB. Desktop (≥900px): a left **navigation rail** (FAB on top) replaces the bottom bar; content is a centered max-width column; Home's deal sections flow in a 2-column grid; the product page is two columns (stats/charts left, History right); dialogs are centered modals instead of bottom sheets.
- **Material 3 look, hand-rolled** in `src/index.css` (no component library): green tonal palette, light theme by **default**, dark theme via `html[data-theme='dark']` — a per-device Settings → Appearance toggle stored in localStorage (`src/lib/theme.js`), never synced.
- **Desktop keyboard shortcuts**: `/` focuses the visible search field, `Esc` blurs an input or navigates back. Firestore loading shows a skeleton shimmer instead of a spinner.
- The app keeps a view stack (tabs reset it, detail screens push onto it). Every navigation is mirrored into browser history (`pushState`, hash = view name, e.g. `#item`), so the **browser/phone Back button navigates within the app** instead of leaving it; the in-app ‹ button triggers `history.back()` so both stay in sync.

## 10. Home screen

- **Home** is the single browse surface: a 🏷️ **Deals** / 📋 **All items** switch (session-persisted). Deals is the deals page (§13) with the 🥩 Meat / 🛒 Groceries mode chips (default Meat); All items is §9. When there are no qualifying deals it shows an empty state explaining deals come from the weekly flyer import.
- **The Location tab was removed.** The store grid lives in the "Where are you?" bottom sheet (§9), opened from Home's 📍 store chip or wherever a store is needed. Known chains show their bundled logo on a white chip over the brand color (`src/lib/logos.js`, matched loosely by name); unknown stores show their name with a logged-price count; the current store is outlined. "+ Add store" creates a store (default unit lb) and selects it. Stores can also be added in Settings → Stores.
- **"vs last" delta badge**: a deal row whose item has an older comparable record shows ▼/▲ n% against that previous price (hidden under 3% — noise). Complements the market-threshold rating badges with the user's own history.

## 11. Bugs & ideas (Settings)

> Settings is organized into scrollable tabs: 🏪 Stores · 📰 Import (whitelist + ignored products) · 💳 Cashback · 🔔 Alerts · 📝 Notes · 💾 Data (backup, security, danger zone). Default tab: Stores.

- A todo list inside Settings (`src/components/Notes.jsx`) for logging **bugs 🐞** and **ideas 💡** while using the app.
- A note is `{id, type, text, done, ts}`; `ts` is set at save time. Stored in `db.notes`, so it syncs across devices and is included in the JSON export.
- Add: pick type (bug/idea), type the text, Add (or Enter). Rows can be checked off (`done`, shown struck through) or deleted (with confirmation).
- Filters: **Open** (default) · 🐞 Bugs · 💡 Ideas · Done. Bug/Idea filters show open notes of that type only. Sorted newest first; the heading shows the open count.

## 12. Weekly flyer import (local job)

- `scripts/flyers/run.mjs`, scheduled by launchd (`com.spmkt.flyers`, Thursdays 8:00) on Diogo's Mac. Logs to `~/Library/Logs/spmkt-flyers.log`.
- For each supermarket in `scripts/flyers/stores.json`, it downloads **every page** of the flyer from flyers-on-line.com (pages are taken in **document order**, not by the `_NN.jpg` suffix — Superstore's page 1 is `_07.jpg`, `_01.._06` being ad inserts), then has Claude (headless CLI, **`claude-haiku-4-5`**) read **all pages in one call per store** — the system prompt, rules and db item names are paid once per store, not per page — and appends the extracted deals to the family Firestore doc. A failed page **download** is skipped with a log (store fails only if all downloads fail); a failed extraction fails the store. Downloaded images are deleted afterwards. (Was page-1-only until the import whitelist existed to keep volume sane; the per-item+store weekly dedupe also swallows cross-page duplicates.)
- Extraction rules: multi-product deals are split into one record per product; meat items get inferred `frozen`/`bones`/`skin` variant flags; per-lb / per-kg / package sizes map to the normal qty+unit model; "2 for $5" → unit price. No weight/volume is ever invented for a by-piece or unsized package — **except** berries sold as a "pint" with no printed weight, which are a standard retail size and always converted to `qty 340 unit "g"`.
- The extraction prompt is given the db's existing item names and told to reuse the exact name when a flyer product matches, so price history continues instead of near-duplicate items being created. Items are then matched by case-insensitive name, otherwise created (`category` meat/other, `kind` from the unit). The store is matched by name or created.
- The extraction also returns `origName` — the product name **as printed on the flyer**. When it differs (case-insensitively) from the item name it's stored on the record as `origName` and shown in History, so grouping under a generic/db name never loses the shelf name.
- Flyer records carry `source: 'flyer'`, `ts` = import time, and `validUntil` = end of the flyer's last valid day (parsed from the site's "Valid from … to …" text; `null` if not found). Dedupe: at most one flyer record per item+store per 7 days (variant excluded: extraction can vary run to run).
- Flyer records also carry `flyerUrl` (the store's flyers-on-line.com URL from `stores.json`) and `flyerPage` (the page the deal was found on, reported by the extraction from the `-pageNN` file names; validated 1..pageCount of the flyer, `null` if missing/out of range). Records imported before this existed have neither.
- **A store whose flyer was already imported within the last 7 days is skipped before downloading** (no image fetch, no Claude call). `--force` re-imports anyway; `--dry-run` extracts without saving.
- **The import never invents a weight**: by-piece deals become `un` records (see §3). This applies to **any** item, not just meat — a "2 for $5" chips deal on an existing weight item is saved as a reference-only `un` record (kept in history, excluded from comparisons) instead of being skipped; the user can fix it later by editing in the real weight. Only a genuine kind clash (e.g. a volume unit on a weight item) is skipped as an extraction error.
- Only **groceries** are imported. Non-grocery flyer content (toys, clothing, kitchenware, pet food, diapers, points-only promos, event ads) is ignored. Products the user deleted & ignored (§9) are skipped by product type.
- **Whitelist cleanup pass (`scripts/flyers/prune-whitelist.mjs`, manual)**: `npm run prune` (or `prune:dry`) reviews every non-meat item against the whitelist with Claude **Opus** and deletes items (plus all their records) matching no rule — for old pre-whitelist imports and mistakes by the cheaper import model. Guards: meat never touched; items with ≥ 1 **manual** price record (source ≠ flyer) never deleted; when in doubt Opus keeps; deleted items are **not** added to the ignored list (the whitelist keeps them out); no-op when the whitelist is off/empty.
- **Import whitelist (Settings → "Import whitelist ✅")**: `db.whitelist` = plain-language keyword rules `{id, text, ts}`, `db.whitelistOn` = on/off toggle. When on **and** non-empty, the extraction prompt tells Claude to keep only **non-meat** products matching at least one rule; rules may carry exceptions and are interpreted, not string-matched ("Yogurt but only Greek style", "Chips but not Pringles", "all fruits but not organic"). **Meat/fish/poultry are exempt — always imported**; unwanted meat is removed per item with Delete & ignore (§9). The ignored list wins over a whitelist match. An empty list with the toggle on imports everything (never silently imports nothing). Toggling off resumes importing everything; items imported while it was on stay until removed manually. Code: `src/lib/whitelist.js`.
- Claude occasionally prints a draft array, reconsiders, and prints a corrected one: the extractor parses the **last** JSON array in the output.
- **Packaged/boxed products (frozen meat boxes, tubs, etc.) are recorded by printed package size** (e.g. 750 g, 1.1 kg), not as 1 unit — so a small FreshCo box is comparable with a big Costco box via the normal per-100g math.
- **UI**: records with a flyer source show a 📰 badge next to the product name (Items list, product page title) and in history rows — green "flyer until \<date\>" while valid, amber "flyer ended \<date\>" after. Expired flyer prices stay in the db as reference.
- **The 📰 badge/text is a link** when the record has `flyerUrl`: opens `flyerUrl#p=<flyerPage>` (the exact flyer page) in a new tab, or just `flyerUrl` when the page is unknown. Old records without `flyerUrl` render as plain text. (`FlyerLink` component; `flyerInfo()` returns the `url`.)
- Auth: prefers a Firebase admin service-account key at `scripts/flyers/service-account.json` (writes directly, bypassing security rules); falls back to signing in with `FAMILY_PASSWORD` from `scripts/flyers/.env`. Both files are gitignored.

## 13. Meat deals (Home) & LLM meat classification

Code: `src/lib/meat.js` (grouping + ratings), `scripts/flyers/classify-meat.mjs` (LLM pass), Home's `MeatDeals`.

### Item classification fields (meat items only)
- `meatType`: `beef` \| `pork` \| `chicken` \| `fish` \| `other` (fish = all seafood; turkey/lamb/duck/mixed → `other`). `null` until classified.
- `processing`: `natural` (whole/raw cuts: steaks, roasts, ground, raw pieces, fillets) or `ultra` (ultra-processed/prepared: nuggets, breaded, sausages, hot dogs, bacon, deli, burgers, marinated ready-meals, canned). **Manually added meat items get `processing` from the AddPrice toggle (default `natural`)**; flyer-created items start `null`.
- `market`: `{ excellent, good, avg, updatedAt }` — Toronto supermarket price thresholds in **CAD $/lb, using prices since Jan 2026 only** (meat prices rose sharply after the Iran war; older prices are misleading), researched by LLM web search (we don't yet have enough own history; may later be replaced by our own data). `excellent ≤ good ≤ avg` is enforced. **Non-meat items get `market` too** (with a `per` basis field) via classify-grocery-market — see the Groceries mode bullets below.
- On merge (§9), the first selected item that has each field wins.

### Classification pass (`classify-meat.mjs`)
- Runs automatically at the **end of every weekly flyer import** (`run.mjs`), and can run standalone (`--all` reclassifies everything, `--new` / `npm run classify:new` classifies only items with no `market` data yet — for right after adding items manually, `--dry-run` doesn't save). A launchd job (`com.spmkt.classify-new`, plist in `scripts/flyers/`) runs `--new` **daily at 9:30** so manually added items get deal thresholds by the next morning; it's a no-op (no LLM call) when nothing is unlabeled.
- Classifies meat items with any field missing and refreshes `market` older than 6 days, in one Claude (headless, WebSearch-enabled) call; matches results back by case-insensitive name and validates enums/thresholds before saving.

### Deals page modes (Home)
- Two modes, toggled by 🥩 Meat / 🛒 Groceries chips under the title (default Meat, not persisted).
- **🛒 Groceries** = every **non-meat** item's current best deal, grouped into one labeled section per category (`groceryType`, in `GROCERY_TYPES` order — like meat's per-type sections), same deal definition as meat (cheapest store's latest non-expired comparable record). Non-meat items have no `meatType`/`processing` (no processing button), but **do** get `market` deal thresholds (below), so the grocery view has the **same rating chips (default excellent + good), rating badges and 🔥 Best deal sort as meat**, plus the category chips and store chips. Items not yet researched show no badge and always pass the rating filter.
- **Grocery market thresholds (`scripts/flyers/classify-grocery-market.mjs`)**: fills `market: {excellent, good, avg, per, updatedAt}` on non-meat items with Claude **Sonnet + WebSearch** (same 2026-Toronto-prices research rules as meat, §13 above), in the basis matching the item's kind — `per`: `lb` (weight) \| `L` (volume) \| `un` (count); `dealRating` in `src/lib/meat.js` picks the conversion from `item.kind`. Runs at the end of the weekly flyer import (after classify-grocery) for items with **no** market data — unlike meat, stale grocery thresholds are **not** auto-refreshed (many items, slower-moving prices); `--all` re-researches everything. Requests are chunked (40 items/call). Standalone: `npm run classify:market` / `classify:market:dry` (`--dry-run`).
- **Grocery category filter (`groceryType`)**: non-meat items carry a `groceryType` — one of `produce | dairy | bakery | frozen | pantry | snacks | beverages | household | other` (typical Toronto supermarket sections). A multiselect chip row (with the same ✕ / All chips as the meat-type row, hidden when only one category has deals) shows only categories that currently have deals, all on by default; unlabeled items count as `other`. Persisted for the browser session, like all Home filters.
- **Classification (`scripts/flyers/classify-grocery.mjs`)**: labels non-meat items with a missing/invalid `groceryType` in one Claude **Haiku** call (name-only, no web search); `--all` relabels everything, `--dry-run` doesn't save (`npm run classify:grocery` / `classify:grocery:dry`). Runs automatically at the end of the weekly flyer import (after classify-meat) so new imports get a category. Results validated against the enum; unmatched names skipped. The enum lives in both `src/lib/meat.js` (`GROCERY_TYPES`) and the script — keep in sync.
- Long-press multi-select (compare mode) and the ➕ RV Groceries button work identically in both modes.

### Home multi-select
One unified selection mode with a contextual action bar — see §9. **Don't import** runs Delete & ignore: after a confirmation dialog, the selected items and all their prices are deleted and their names appended to `db.ignored`, so future flyer imports skip that product type (any brand). Undo in Settings ("Stop ignoring"; deleted prices are not restored).

### Meat deals section (Home)
- Groups: **Beef, Pork, Chicken, Fish, Other meat**. Meat with no `meatType` yet gets an **instant keyword guess from its name** (`guessMeatType` in `src/lib/meat.js`, also stamped on manually created meat items) so e.g. "Chicken whole" files under Chicken right away; if no keyword matches it falls under Other until the weekly LLM pass classifies it. Per meat type, `natural` items form one section and `ultra` items form a separate **"<Type> · ultra-processed"** section right after it (no per-row ultra-processed chip). Empty sections are hidden.
- One row per meat item: its current best deal = cheapest of each store's **latest non-expired comparable** record. **Expired flyer prices (`validUntil` in the past) are never shown** — unless the **⏰ Expired** toggle (end of the Sort chip row, off by default, both modes) is on: expired records then compete too (latest per store still wins) and an expired deal's row shows a muted **"ended \<date\>"** instead of "until". Records without `validUntil` (manual entries) never expire.
- **By-piece records (§3) get their own extra row** (both modes): an item can appear twice — "Doritos $2.13/lb" and "Doritos $6.00/unit 📦 by piece". The by-piece row shows the cheapest per-unit price among each store's latest non-expired `un` records, a **📦 by piece** badge and **no rating** (a $/unit price can't be rated against $/lb thresholds); it exists so by-piece imports stay visible until the user edits in the real weight. By-piece rows can't be picked in ⚖️ Compare mode (nothing comparable), but hold-to-select / Don't import works (selection is per item — both of the item's rows toggle together).
- Row shows: item name, `cheapest @ <store>` (+ `until <date>` for flyer deals), price in display units, and a deal rating badge vs `market` ($/lb): ≤ excellent → **🔥 Excellent deal**, ≤ good → **👍 Good deal**, ≤ avg → average, else bad. Items with no market data yet still show, without a badge. Items with **more than one record in history** also show a muted **📊 \<n\>** count next to the store line (both modes). Tapping a row opens the product page.
- **Filters (multiselect chips above the list):** by deal rating, meat type (multiselect; only types that currently have deals get a chip; all on by default) and by store; plus a processing chip at the end of the mode-chip row that cycles **All → Natural → Ultra-processed** (default All, meat mode only). The always-visible Home **search bar** filters the deal rows by name (case-insensitive substring; same field filters All items). Rating filter defaults to **excellent + good** (so Home shows real deals by default; average/bad can be opted in). Store chips list the stores that currently have deals, all selected by default (a row shows only if its store chip is on **and** its rating chip is on); the store chip row is hidden when only one store has deals. The meat-type and store rows each start with a ✕ chip that deselects everything in that row (to quickly pick just one). Items with no market data always pass the rating filter. The mode toggle and all Home filters/sort are persisted in `sessionStorage` (`src/lib/useSessionState.js`), so they survive navigating to another tab and back (and reloads) within the browser session; they reset to defaults when the tab is closed.
- **Sort (single-select chips):** **$ Cheapest** (normalized price asc, default), **🔥 Best deal** (price relative to the item's `market.avg`, biggest discount first; items without market data last), **A–Z** (name). Applies within each section.
- **➕ Send to RV Groceries (`src/lib/rvlist.js`).** Every deal row ends in a round **+** button (hidden in compare mode) that pushes the deal to the separate **RV & Groceries** app (Firebase project `rv-groceries`): it POSTs `{ storeName, itemName, priceLabel, validUntil }` to that project's `addFromSmartPrice` Cloud Function, authenticated with **our own Firebase ID token** (the function verifies it against this project's `securetoken` certs; CORS is also limited to our origins — no secret in the bundle). The item lands on that store's active shopping list showing the price and "valid until"; the other app hides/deletes it automatically once `validUntil` passes. Button states: `+` → `…` (sending) → `✓` (landed), or `!` for ~2.5s on failure then back to `+`.
  - **The ✓ persists.** A successful send is stored in `db.rvSent` (`{itemId, recId, ts}`), so the ✓ survives reloads and other devices show it too. Home and the Item Detail per-store price rows share these markers: sending from either screen shows ✓ on both. It stays as long as **that same record** is the row's current deal; when a new flyer price takes over (new `recId`) the button returns to `+` so the fresher deal can be sent. Stale markers (record expired or deleted) are pruned on each new send.
  - **Strictly one-way.** Checking off, unchecking, or deleting the item in the RV app never syncs back — the ✓ here only means "this deal was sent", not "still on that list". Tapping a ✓ does nothing; a changed deal (new record) re-enables `+`, and re-sending updates the item's price/expiry over there instead of duplicating.

## 15. 📷 Photo mode (Review tab)

The in-store fast path: snap the shelf label, review at home. Code: `src/lib/photos.js`, `src/screens/Review.jsx`, `scripts/photos/process.mjs`.

- **Capture**: "📷 Snap label" button in AddPrice's top bar and on the Review tab (rear camera via `capture="environment"`). Requires a current store (the store sheet appears first otherwise) — the store is stamped on the entry at capture time. The photo is compressed client-side (max 1400px, JPEG q0.72, ~100–300 KB) and uploaded to Firebase Storage at `photos/{uid}/{id}.jpg`; a `pending` entry is appended to `db.photoQueue`. Storage rules (`storage.rules`): only the owner may read/write their folder, ≤ 3 MB.
- **Processing** (`scripts/photos/process.mjs`, `npm run photos` / `photos:dry`; launchd `com.spmkt.photos` daily **9:20**, logs to `~/Library/Logs/spmkt-photos.log`; requires `scripts/flyers/service-account.json`): downloads pending photos, one Claude call (headless CLI, **Haiku**, vision via Read) extracts per photo: product name (**reusing an exact existing item name on a match**, like the flyer import), price, qty+unit (never inventing a weight — by-piece → `un`, §3), category, meat `frozen/bones/skin/processing` or non-meat `groceryType` (auto-categorized), and an optional note. Valid extractions become `status: 'ready'` (+ `matchedItemId`); unreadable ones `'failed'` with an error. **Photos are deleted from Storage after the extraction is saved** — the bucket stores nothing long-term. Dry-run keeps photos and saves nothing.
- **Review tab**: `ready` entries are **big cards showing every field** (price, qty/unit, store, date, category, meat flags, match-vs-new badge, note) so the only decision is **✓ Approve** (creates the item if needed and appends the record with `ts` = photo time and `source: 'photo'`) or **✏️ Edit** (opens AddPrice prefilled from the extraction; saving consumes the queue entry). "✓ Approve all (n)" approves every ready card in one batch. `pending` entries show a thumbnail + "waiting"; `failed` ones offer Enter manually / Discard. Discard is undoable via snackbar. The nav badge shows the queue size.

## 15b. Snackbars & undo

Recoverable actions use a **snackbar with UNDO** (5 s) instead of a blocking confirm: deleting a price record (History), discarding a review photo. Genuinely destructive bulk actions keep their confirmation dialog: Don't import (delete & ignore) and Merge. `src/lib/toast.js` + `src/components/Snackbar.jsx`.

## 15c. Product-page History display

- Sorted **cheapest-first by default** (reference-only by-piece records at the bottom, date-desc among themselves), with a `$ Price / 🕒 Date` toggle.
- Expired flyer records are **dimmed**; a "Hide expired" button (shown only when some are expired) filters them out. Display-only — stats/comparisons are unaffected.

## 16. Roadmap (agreed, not yet built)

- ~~Phase 2: Firebase (auth + Firestore sync)~~ — **done (2026-07)**: Google auth, Firestore db, Hosting, GitHub auto-deploy (`.github/workflows/deploy.yml`, pushes to `main` on github.com/diogoweb2/spmkt). Notifications and offline data intentionally left out.
- ~~Phase 3: photo of shelf label → AI → structured entry~~ — **done (2026-07)**: photo mode, §15.
- Phase 4: weekly-flyer search per product.
- Price-evolution line chart per product (deferred from the 2026-07 redesign).
