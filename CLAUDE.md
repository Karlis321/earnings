# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Personal earnings-tracking dashboard for the user (Karlis). The front-end is
built and runs on fixtures; the backend is spec'd but not implemented. All
data ingested is publicly available (Yahoo, EDGAR, Google News, IR RSS, etc.)
— no corporate constraints, no auth, no Cloudflare, no Vercel-blocked egress.

## Folder layout

```
earnings_dashboard/
├── README.md, CLAUDE.md, DEPLOY.md, answer.txt, prompt1.txt   (top-level)
├── frontend/       Next.js 15 App Router — the built app
├── backend/        Placeholder (backend not yet implemented)
├── design/         Signal design system export
└── docs/           All PRDs + plans
    ├── PRD_Project.md
    ├── PRD_Frontend.md
    ├── PRD_Backend.md
    ├── Plan_Frontend_Build.md
    ├── Plan_WireUp.md
    └── reference_mockup.png
```

## Read-before-coding order

1. `docs/PRD_Project.md` — **§6 Data Model**, **§7 Technical Considerations**,
   **§9 Integration Details**, and all of **Appendix C** (build guide,
   contracts, task list, connection manifest). Note: BluOr-internal-tool
   framing has been rebranded to personal-use, and §M1 auth is now N/A.
2. `docs/PRD_Project.md` **Appendices A & B** for the exact vendor endpoints,
   headers, quirks, and matching/quality utilities — these are the ported
   behavior contracts.
3. `docs/PRD_Backend.md` — the concrete spec for the backend to build.
   Includes the wire shapes, endpoint list, no-auth model, and edge-case
   handling.
4. `docs/Plan_WireUp.md` — the ordered W0–W8 phased plan for wiring the
   frontend to the backend. Every phase has an acceptance checkpoint.
5. `docs/PRD_Frontend.md` §6 (component library) and §7 (per-view specs)
   before touching UI.

## Load-bearing invariants (non-obvious, easy to violate)

These are the rules that come from reading multiple sections together:

- **Reuse the reference connections exactly.** Endpoints, headers, params,
  parsing, and fallback shapes are fixed by PRD Appendices A/B (they encode
  vendor-specific quirks — e.g. SEC EDGAR requires a contact `User-Agent`;
  Q4-hosted IR feeds `403` on non-browser UAs; B3 Mziq needs POST +
  `Origin`/`Referer`; Google News redirect URLs must go through the article
  verifier). **Never invent an endpoint, header, or field name. If a spec is
  missing, stop and flag it — do not guess.**
- **Every sourced number is a `Fact`.** Shape: `{value, unit,
  source:{url,label,provenance,locator}, asOf, fetchedAt, method,
  confidence}`. `method ∈ {yahoo, fmp, bloomberg_manual, filing_manual,
  llm_extracted}`. Derived numbers (reaction returns) store formula inputs +
  `computedAt` instead of pretending to be Facts. Unavailable data is stored
  as `null` with a staleness flag — never blank, never fabricated.
- **Type-first rendering.** `securityType` is `operating | developer | etf`.
  Operating → earnings flow (estimates, actuals, surprise, guidance).
  Developer → catalyst flow, never "earnings/estimate/miss-beat" (they don't
  exist). ETF → price / distributions / holdings only, no events. Enforced
  in the component layer, not per-page copy.
- **Storage v1 is git-snapshot, not a database.** State is versioned JSON
  committed to the repo via the **GitHub Contents API commit-pipe**. GET
  file SHA → PUT with it → handle `409` (stale SHA → refresh + retry) and
  `503` (no `GH_PAT` → graceful localStorage-only fallback). The
  Prisma/Postgres model in `docs/PRD_Backend.md` Appendix A is the upgrade
  path, not v1.
- **Events are sharded per ticker; `earnings.json` is a frozen archive.**
  Source of truth is `data/events/<TICKER_SLUG>.json` (one shard per
  ticker) + `data/events-index.json` (lightweight grid summary). Cron
  writes only shards + index. `data/earnings.json` is `.gitignored` and
  kept locally for backfill scripts; it is never re-committed. Runtime
  reads reconstitute from shards via `gitSnapshot.readEarnings()` with a
  60s in-process cache (see `frontend/server/stores/gitSnapshot.ts`).
- **Repo weight — organic growth is ~10–15 MB/year.** The 18 → 101 MB jump
  in July 2026 was a one-time backfill step (Yahoo timeseries + SEC XBRL
  pushed 8,486 events across 1,416 tickers). Organic growth from here is
  ~6k events/year at current JSON density. Revisit only if the plan
  becomes to store per-ticker full-text summaries for the ~1,500-name
  universe — until then, no action.
- **Residual coverage gap (~14% ≈ 235 foreign tickers) is a deferred
  purchase decision, not a bug.** Yahoo timeseries + SEC XBRL closed the
  US path; FMP's free tier is US-primary-only (foreign symbols return
  HTTP 402 "Premium Query Parameter"), and the gap is exclusively
  foreign ADRs and pink sheets. Closing it costs: FMP paid ≈$19/mo
  (verify foreign coverage before paying — 402 doesn't prove data
  exists behind it) or EODHD ≈€60/mo (built for exactly this
  population). Current stance: **don't buy**. The estimator carries
  most of these on cadence-based next-event shells; cards render
  "reported · no est" honestly for actuals; covered tier gets full
  treatment via Claude. Revisit only when an analyst names a specific
  missing ticker — that's the demand signal worth €60/mo.
- **~86% of Yahoo-provenance events are structurally unverifiable against
  SEC.** The July-2026 financials audit (`scripts/verify-financials.mjs`)
  sampled 150 stratified events; 129 were unverifiable, of which the
  vast majority were foreign-listed (no `edgarCik` → no SEC XBRL to
  compare against). This is a structural fact of the ingest population,
  not a sampling failure — there is no free second source for most
  foreign wrappers. Two mitigations, both cheap and both in place:
  **(a)** `companies_with_inconsistent_financials` on `pipeline-report/v2`
  catches multi-listing revenue drift (Alphabet's four listings showing
  four different Q2 2026 values was the surfacing bug) *without* any
  external source — just cross-listing invariant math via companyId.
  **(b)** For the two `yahoo-timeseries` events in the sample that
  were verifiable, both matched SEC at 0.00% — a small (n=2) but real
  signal that the pipe is clean; don't over-claim from the sample.
- **sec-xbrl-companyfacts backfill: fetch per-CIK once, distribute
  values to every listing (never per-listing).** Root cause of the
  same July-2026 audit's Alphabet finding: the old backfill fetched SEC
  per-listing and each pass captured a different XBRL snapshot, so
  GOOG US / GOOGL US / GOGL34 BZ / 0HD6 LN stored four different Q2
  revenue values. Fix: `scripts/rederive-sec-xbrl.mjs` fetches once per
  companyId (via `Entity.companyId` from Part 2 of the dedup work) and
  applies the same values to every listing. Also enforces a strict
  80–100-day pure-quarter span filter (the old permissive filter let
  180-day H1 sums through). Re-derivation moved 3,644 metrics across
  184 companies; verification error rate dropped 37% → 2.3%.
- **SEC-verbatim rule at ingest (kills per-provenance-exclusion bugs).**
  Root cause of the July-2026 residuals (ENB CN unit mismatch, NOV GR
  DKK-vs-USD scale, TTE 44,676-vs-49,627 cluster, WELL FX round-trip):
  the old rederive only touched events with `provenance:
  "sec-xbrl-companyfacts"`, so Yahoo-ingested siblings on the same
  company drifted separately. Rule now enforced in the daily cron
  (`frontend/server/lib/secVerbatim.ts` invoked as step 3d in
  `/api/cron/daily`): for any listing of a company where ANY sibling
  has an `edgarCik`, financial metrics come from SEC XBRL verbatim
  regardless of ingest provenance — per-company fetch (cached per
  companyId across the run), actual `unitKey` from the SEC response
  (never hardcoded USD — Enbridge only files CAD, Novo only DKK),
  latest-filed wins for amendments, distributed to every listing.
  Yahoo/FMP values are superseded at ingest into `metric.superseded[]`,
  never stored as primary. Standing test:
  `node scripts/test-standing.mjs` runs the pipeline check + a
  corruption test that plants a divergent value on one GOOGL listing
  and asserts `companies_with_inconsistent_financials` fires with the
  companyId in `reasons[]`, then restores and asserts back to `ok`.
- **Wire shape is collapsed, DB shape is normalized (DC4).** On the wire,
  metrics carry named slots (`estimate`, `actual`, `prior`, `consensus`) —
  see `frontend/lib/types.ts` and `docs/PRD_Backend.md §3.3`. In the future
  Postgres schema each slot maps to a `Fact` row with a `role`. The store
  layer maps between them; endpoints only ever see the collapsed shape.
- **Optimistic local + commit-pipe latency (~1 min).** Writes update
  localStorage and the UI immediately; a "Syncing…" indicator tracks the
  commit; on mount the client merges the deploy-baked snapshot over local.
  If `GH_PAT` is absent, writes remain local and a persistent "Local only"
  banner shows — nothing is lost.
- **Server-only vendor egress.** All vendor calls run server-side. Secrets
  (`GH_PAT`, `ANTHROPIC_API_KEY`, `TWITTERAPI_IO_KEY`, `FMP_API_KEY`,
  `CRON_SECRET`) live only in server env vars. Frontend reads the committed
  snapshot / API routes; it never fetches vendors directly.
- **Vercel-only, no Cloudflare (DC15).** X posts via Nitter are dropped for
  v1 (Nitter is blocked from Vercel egress and we're not deploying a
  Cloudflare Worker). TwitterAPI.io stays as an *optional* paid path.
- **FMP is fallback-only, optional.** Yahoo `quoteSummary` is the primary
  source for prices, earnings dates, and estimates. FMP (~250 req/day free)
  covers only consensus estimates Yahoo doesn't return cleanly — and only if
  a key is present.
- **Reaction is derived, not stored as Facts.** For each event compute abs +
  excess vs an assigned benchmark at four horizons (`d1`, `d3`, `w1`, `m1`,
  where `m1` = +1 month). Baseline anchor depends on timing: **BMO → event
  day close**, **AMC → next session close**. Trading calendars are derived
  from the security's own returned bars (DC7). Horizons that haven't elapsed
  render as `"pending — populates <date>"`, never zero or blank. A benchmark
  price gap flags the affected horizon; a delisting flips it to `terminal`.
- **Fail soft, visibly.** A dead source returns `[]` and siblings keep
  running. In the UI this becomes an inline `SourceUnavailableChip`, not a
  hidden panel.
- **$0 / no-LLM UI mode is the current shipping mode (DC8).** No generated
  summaries, no machine translation. Source items show headline + source +
  provenance + heuristic `ArticleTypeBadge` (news/opinion) + `LanguageBadge`.
  The summary slot is **hidden**, not empty. When LLM enrichment is later
  enabled it fills that slot.
- **No auth (DC6).** Public URL by design. No `/login`, no `RoleProvider`,
  no `AdminGuard` — all removed. If access needs restricting later, enable
  Vercel Deployment Protection (dashboard toggle, zero code).
- **Fixtures-first front end.** The whole app runs on fixtures today. Wire
  it up via `docs/Plan_WireUp.md` phase-by-phase; the seam is
  `frontend/lib/apiClient.ts` gated by `FEATURE_FLAGS.liveMode` per method.
- **Plain English UI copy.** No jargon. Short sentences, verdict-style
  phrasing. Every headline number must have a working click-through to its
  primary source.

## Toolchain

- Next.js 15.1 (App Router) + React 19 + TypeScript 5.7
- Tailwind CSS v4 with CSS-first token layer
  (`frontend/app/globals.css`). Design tokens mirror the Signal design system
  in `design/` — three themes (`dark` default, `dim`, `light`) toggled via
  `data-theme` on `<html>`.
- IBM Plex Sans + Mono (via `next/font/google`); mono uses `tabular-nums`
  for every figure.
- `@radix-ui/react-*` for `Dialog`, `Popover`, `Tooltip`, `DropdownMenu`.
  `lucide-react` for icons.

## Commands (run from `frontend/`)

- `npm run dev` — Next dev server (default port 3000).
- `npm run build` — production build.
- `npm run start` — serve build output.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `next lint`.

## Fixture mode vs live mode

Everything in the app reads through `frontend/lib/data.ts` (fixtures) or
`frontend/lib/apiClient.ts` (live-mode branch). The `FEATURE_FLAGS.liveMode`
flag in `frontend/lib/flags.ts` is the single seam — flip it once the
backend endpoints exist. Every live-mode branch throws a specific error
naming the missing endpoint, so it's obvious what's still stubbed.

## Route map (11 built)

- `/` — Watchlist overview
- `/s/:ticker` — Security detail (operating / developer / etf, type-routed)
- `/s/:ticker/e/:eventId` — Event (print) detail
- `/sectors`, `/sectors/:sectorId` — Sector view (flagged)
- `/admin`, `/admin/securities/new`, `/admin/securities/:ticker`,
  `/admin/entry/:ticker`, `/admin/sources`, `/admin/feedback` — Admin surfaces
- `/settings` — Theme, feature flags, data status
- `/gallery` — Component gallery (every primitive in every state)

## Backend integration flags — where the front end plugs in

Every place in the code that needs a real backend endpoint carries an inline
`// Backend integration flag:` comment naming the exact endpoint from the
Wire-Up Plan. Ripgrep `Backend integration flag` to enumerate them. Summary
of the 🔴 wire points:

- `frontend/lib/apiClient.ts` — the entire live-mode branch
- `GlobalSearch` — `/api/ticker-lookup` for unknown-ticker resolve
- `SourcesPanel` "Refresh sources now" — `/api/news` + `/api/press-releases`
  + `/api/tweets`
- `SourceViewer` hosted-mode — hosted Document/Segment content
- `AddEditSecurityForm` "Resolve" + "Save" — `/api/ticker-lookup` +
  entity-registry write via commit-pipe
- `ManualEntryForm` save — earnings/guidance store write
- `admin/sources` Discover + Save — `/api/discover-feed` + `/api/shared-state`
- `admin/feedback` adjust — `/api/feedback`
- Settings Data Status detail — cron metadata / probe

All of these degrade to fixtures now with a toast informing what would
happen live.

## When you make architectural changes

Update the PRDs (`docs/PRD_*.md`) alongside the code — they are the
specification, not a snapshot. In particular: adding an endpoint means
updating `PRD_Backend.md §5` + `PRD_Project.md §9`; adding an entity field
means updating both PRDs' data-model sections; a new frontend component
means the `PRD_Frontend.md §6` + relevant view section.
