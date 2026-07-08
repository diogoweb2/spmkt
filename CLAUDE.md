# Smart Price (Spmkt)

Mobile-first React + Vite PWA that tells the user if a grocery price is a good deal. Phase 2: Firebase project `spmkt-cc6fd` (Google auth + Firestore + Hosting); repo github.com/diogoweb2/spmkt auto-deploys `main` via GitHub Actions (`.github/workflows/deploy.yml`).

## Business rules — mandatory process

**`BUSINESS_RULES.md` is the source of truth for app behavior.**

- BEFORE any business-logic change: read `BUSINESS_RULES.md` and check the change against it.
- AFTER any business-logic change: update `BUSINESS_RULES.md` in the same change.

## Commands

- `npm run dev` — dev server on port 5180 (5173 is used by another project)
- `npm run build` / `npm run preview` — preview serves on 5181
- `npm run lint` — oxlint

## Layout

- `src/lib/` — units/normalization, analysis (verdicts/comparisons), firebase (app/auth init), db (Firestore data layer, one doc per user), logos
- `src/screens/` — SignInScreen, Home, AddPrice, ItemDetail, Items, Settings
- `src/components/` — MonthlyChart, UnitToggle
