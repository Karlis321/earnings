# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo currently is

Spec-only. No code, no `package.json`, no build/test/lint tooling exists yet. Contents:

- `PRD_Earnings_Catalyst_Dashboard.md` — the project PRD (product + backend + data + integrations). **This is the source of truth.** Its Appendix C is a build guide written specifically for a coding agent.
- `FrontEnd_PRD_Earnings_Catalyst_Dashboard.md` — exhaustive front-end spec (views, components, journeys, states).
- `FrontEnd_Build_Plan_Earnings_Catalyst_Dashboard.md` — ordered phased build plan (P0–P12) with per-task backend-dependency flags.
- `Design_system/Signal Design System.dc.html` + `support.js` — exported design system (tokens, components, screenshots) to be honored by the UI.
- `earnings_dashboard.png` — the reference mockup.

The first coding task is to scaffold the app (`PRD Appendix C.1` and `Build Plan P0`). Do not invent build/test/lint commands or claim they exist — add them to this file once the toolchain is chosen and committed.

## Read-before-coding order

1. `PRD_Earnings_Catalyst_Dashboard.md` **§6 Data Model**, **§7 Technical Considerations**, **§9 Integration Details**, and all of **Appendix C** (build guide, contracts, task list, connection manifest).
2. `PRD` **Appendices A & B** for the exact vendor endpoints, headers, quirks, and matching/quality utilities — these are the ported behavior contracts.
3. `FrontEnd_PRD` §6 (component library) and §7 (per-view specs) before touching UI.
4. `FrontEnd_Build_Plan` for the ordered task list and the Backend Dependency Register (which UI tasks can ship on fixtures vs. need a live backend).

## Load-bearing invariants (non-obvious, easy to violate)

These are the rules that come from reading multiple sections together:

- **Reuse the reference connections exactly.** Endpoints, headers, params, parsing, and fallback shapes are fixed by PRD Appendices A/B (they encode vendor-specific quirks — e.g. SEC EDGAR requires a contact `User-Agent`; Q4-hosted IR feeds `403` on non-browser UAs; B3 Mziq needs POST + `Origin`/`Referer`; Google News redirect URLs must go through the article verifier). **Never invent an endpoint, header, or field name. If a spec is missing, stop and flag it — do not guess.**
- **Every sourced number is a `Fact`.** Shape: `{value, unit, source:{url,label,provenance,locator}, asOf, fetchedAt, method, confidence}`. `method ∈ {yahoo, fmp, bloomberg_manual, filing_manual, llm_extracted}`. Derived numbers (reaction returns) store formula inputs + `computedAt` instead of pretending to be Facts. Unavailable data is stored as `null` with a staleness flag — never blank, never fabricated.
- **Type-first rendering.** `securityType` is `operating | developer | etf`. Operating → earnings flow (estimates, actuals, surprise, guidance). Developer → catalyst flow, never "earnings/estimate/miss-beat" (they don't exist). ETF → price / distributions / holdings only, no events. This is enforced in the component layer, not per-page copy.
- **Storage v1 is git-snapshot, not a database.** State is versioned JSON committed to the repo via the **GitHub Contents API commit-pipe** (`shared-state.js` / `feedback.js` pattern from the reference). GET the file SHA → PUT with it → handle `409` (stale SHA → refresh + retry) and `503` (no `GH_PAT` → graceful localStorage-only fallback). The Prisma/Postgres model in PRD §6 is the documented upgrade path, not v1. `data/earnings.json` is written by the cron the same way `data/tweets.json` is in the reference build.
- **Optimistic local + commit-pipe latency (~1 min).** Editor writes update localStorage and the UI immediately; a "Syncing…" indicator tracks the commit; on mount the client merges the deploy-baked snapshot over local. If `GH_PAT` is absent, writes remain local and a persistent "Local only" banner shows — nothing is lost.
- **Server-only vendor egress.** All vendor calls run server-side. Secrets (`GH_PAT`, `ANTHROPIC_API_KEY`, `TWEET_WORKER_URL/SECRET`, `TWITTERAPI_IO_KEY`, `FMP_API_KEY`) live only in server env vars — never shipped to the client. The frontend reads the committed snapshot / API routes; it never fetches vendors directly.
- **Vercel egress caveats.** Yahoo `query2`, SEC EDGAR, Google News / Bing / GDELT / HN, IR RSS, Newsfile, B3 Mziq, GitHub Contents, Anthropic — all work from Vercel. **Blocked from Vercel datacenter IPs:** Nitter, DuckDuckGo, Bluesky — reached via a Cloudflare Worker proxy (`TWEET_WORKER_URL` + `TWEET_WORKER_SECRET`). `yfinance` (the Python lib) is used **only** for local backfill from a residential IP; production uses Yahoo `query2` REST directly.
- **FMP is fallback-only.** Yahoo `quoteSummary` is the primary source for prices, earnings dates, and estimates where present. FMP (~250 req/day free) covers only consensus estimates Yahoo doesn't return cleanly. Do not architect around FMP as primary.
- **Reaction is derived, not stored as Facts.** For each event compute abs + excess vs an assigned benchmark at four horizons (`d1`, `d3`, `w1`, `m1`, where `m1` = +1 month). Baseline anchor depends on timing: **BMO → event day close**, **AMC → next session close**. Horizons that haven't elapsed render as `"pending — populates <date>"`, never zero or blank. A benchmark price gap flags the affected horizon rather than silently computing on partial data.
- **Fail soft, visibly.** A dead source returns `[]` and siblings keep running. In the UI this becomes an inline `SourceUnavailableChip`, not a hidden panel. Amber freshness dots over hidden fields.
- **$0 / no-LLM UI mode is the current shipping mode.** No generated summaries, no machine translation. Source items show headline + source + provenance + heuristic `ArticleTypeBadge` (news/opinion) + `LanguageBadge`. The summary slot is **hidden**, not empty. When LLM enrichment is later enabled it fills that slot.
- **Fixtures-first front end.** Phases 0–2 of the build plan (setup, shell, full component library) and the fixture mode of Phases 3–8 need **zero backend**. Every view is built against JSON fixtures that mirror the real API shapes (PRD Appendix C.5/C.6). Backend dependence is isolated to explicit "wire live" tasks — see the Build Plan's Backend Dependency Register.
- **Plain English UI copy.** No jargon ("re-rate", "the drill bit"). Short sentences, verdict-style phrasing. Every headline number must have a working click-through to its primary source.

## Target architecture (from PRD §6 + Appendix C.1)

Next.js on Vercel. Split by responsibility:

- `data/` — versioned JSON snapshots, the v1 store: `entity-registry.json` (single source of truth, ported + extended with earnings fields per Appendix C.5), `earnings.json` (event snapshots written by the cron), `shared-state.json`, `feedback-log.json`.
- `api/` — server-only endpoints. Underscore-prefixed files are shared modules (registry loader, official-sources registry, feed fetcher, HTML helpers, search engines, article verifier, ticker/tweet matchers, tweet quality, FinTwit accounts, Yahoo client, reaction engine, earnings store). Public endpoints wrap them: `news`, `press-releases`, `tweets`, `discover-feed`, `shared-state`, `feedback`, `ticker-lookup`, `earnings`, and `cron/daily`.
- `src/` — cross-runtime (client + api) helpers: `entityRegistry` mirror, `itemTagger`.
- `app/` — the frontend (overview, security detail with three type variants, event detail, source viewer, admin surfaces).
- `scripts/` — one-time backfill scripts (e.g. yfinance historical bars) run locally from a residential IP.

**Ported vs. new** — treat these two lists as authoritative:
- **Ported verbatim from the reference news-tracker codebase** (behavior fixed by Appendix A/B): `_html`, `_entityRegistry`, `_officialSources`, `_feedFetcher`, `_searchEngines`, `_articleVerifier`, `_tickerMatch`, `_tweetQuality`, `_finTwitAccounts`, and endpoints `news`, `press-releases`, `tweets`, `discover-feed`, `shared-state`, `feedback`, `ticker-lookup`.
- **New for this project:** `_yahoo`, `_reaction`, `_earningsStore`, `api/earnings`, `api/cron/daily`, the `entity-registry.json` earnings extension, and the entire frontend.

## Daily cron orchestration (`api/cron/daily.js`)

Must be idempotent and safe to re-run. Order (from PRD Appendix C.7):

1. Per core ticker: `_yahoo.resolveSymbol` → `fetchQuote` → append to price cache.
2. `fetchEarningsMeta` (operating) / registry catalyst dates (developer) → upsert `scheduledDate`.
3. Detect a new actual print → create/complete `Event`, capture actuals as Facts, compute `surprisePct`, classify `guidanceMove`.
4. For each open Event: compute newly-matured reaction horizons via `_reaction`.
5. For each Event inside its source window: poll `press-releases` + `news` + `tweets` scoped by the entity's aliases, gate via matching/quality utilities (Appendix B.1/B.2), enrich (when LLM is on), append with dedup.
6. `writeEarnings` — one commit per refresh (that commit IS the ledger).

Recompute staleness at read time. Never overwrite good data on a vendor gap — flag it stale instead.

## Build task order

Follow `FrontEnd_Build_Plan_Earnings_Catalyst_Dashboard.md` (P0 → P12) for the UI and PRD `Appendix C.8` (T1 → T10) for the backend. Each task in both lists has a stated acceptance check — do not start a task until its dependencies pass.

## When you make architectural changes

Update the PRDs alongside the code — they are the specification, not a snapshot. In particular: adding an endpoint means updating PRD §9 + Appendix A; adding an entity field means updating §6 + Appendix C.5/C.6; a new frontend component means the Front-End PRD §6 + relevant view section.

## Toolchain (front-end scaffold committed)

- **Framework:** Next.js 15.1 (App Router) + React 19 + TypeScript 5.7.
- **Styling:** Tailwind CSS v4 with CSS-first token layer (`app/globals.css`). Design tokens mirror the Signal design system in `Design_system/` — three themes (`dark` default, `dim`, `light`) toggled via `data-theme` on `<html>`.
- **Fonts:** IBM Plex Sans + IBM Plex Mono (via `next/font/google`); mono uses `tabular-nums` for every figure.
- **UI primitives:** `@radix-ui/react-*` for `Dialog` (SlideOver / Modal), `Popover` (FactPopover), `Tooltip` (FreshnessDot / ArticleTypeBadge), `DropdownMenu` (SecuritySwitcher). `lucide-react` for icons.

### Commands

- `npm run dev` — Next dev server (default port 3000).
- `npm run build` — production build.
- `npm run start` — serve build output.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `next lint`.

### Fixture mode vs live mode

Everything in the app reads through `lib/data.ts` (fixtures) or `lib/apiClient.ts` (live-mode branch). The `FEATURE_FLAGS.liveMode` flag in `lib/flags.ts` is the single seam — flip it once the backend endpoints exist. Every live-mode branch throws a specific error naming the missing endpoint, so it's obvious what's still stubbed.

### Route map

- `/` — Watchlist overview
- `/s/:ticker` — Security detail (operating / developer / etf, type-routed)
- `/s/:ticker/e/:eventId` — Event (print) detail
- `/sectors`, `/sectors/:sectorId` — Sector view (flagged)
- `/admin`, `/admin/securities/new`, `/admin/securities/:ticker`, `/admin/entry/:ticker`, `/admin/sources`, `/admin/feedback` — Admin surfaces (editor-only)
- `/login` — Auth stub
- `/settings` — Theme, role toggle, feature flags, data status
- `/gallery` — Component gallery (every primitive in every state)

### Backend integration flags — where the front end plugs in

Every place in the code that needs a real backend endpoint carries an inline `// Backend integration flag:` comment naming the exact endpoint from the Backend Dependency Register (Build Plan). Ripgrep `Backend integration flag` to enumerate them. Summary of the 🔴 wire points:

- `lib/apiClient.ts` — the entire live-mode branch
- `Header` search / `GlobalSearch` — `/api/ticker-lookup` for unknown-ticker resolve
- `SourcesPanel` "Refresh sources now" — `/api/news` + `/api/press-releases` + `/api/tweets`
- `SourceViewer` hosted-mode — hosted Document/Segment content
- `AddEditSecurityForm` "Resolve" + "Save" — `/api/ticker-lookup` + entity-registry write via commit-pipe
- `ManualEntryForm` save — earnings/guidance store write
- `admin/sources` Discover + Save — `/api/discover-feed` + `/api/shared-state`
- `admin/feedback` adjust — `/api/feedback`
- `LoginPage` — auth provider (P9)
- `settings` Data Status detail — cron metadata / probe (P12-T2)

All of these degrade to fixtures now with a toast informing the user what would happen live.
