# Front-End Build Plan — Earnings & Catalyst Dashboard

*Step 3. Converts `FrontEnd_PRD_Earnings_Catalyst_Dashboard.md` into an ordered, dependency-aware build sequence. Draft v1.0.*

## How to read this plan

**Core strategy — fixtures-first.** Every view is built and made fully interactive against **fixture data** that mirrors the real API shapes (project PRD Appendix C.5/C.6). This means the entire front end is buildable and demoable *before any backend exists*. Backend dependence is isolated to explicit "wire live" tasks and collected in the [Backend Dependency Register](#backend-dependency-register). Nothing in Phases 0–2 touches a backend at all.

**Task IDs:** `P<phase>-T<task>`. **Dependencies** are listed per phase and per task where they cross phases.

**Backend-data flags (per task):**
- 🟢 **No backend** — builds and functions entirely on fixtures / client logic.
- 🟡 **Backend-optional** — functions on fixtures; a live feature (e.g., cross-device sync, URL resolution) needs a backend but degrades gracefully.
- 🔴 **Requires backend to function** — the task's live behaviour cannot work without the named endpoint/output; until then it runs in fixture mode behind a flag.

**Backend outputs referenced** (built separately per project PRD Appendix C): `/api/shared-state`, `/api/earnings`, `/api/news`, `/api/press-releases`, `/api/tweets`, `/api/ticker-lookup`, `/api/discover-feed`, `/api/feedback`, the entity-registry read/write, hosted Document/Segment content, the daily cron (produces `earnings.json`), and the auth provider.

---

## Phase 0 — Project Setup & Fixtures
**Goal:** a booting app with routing, theming, and a fixture layer that mirrors backend shapes. Foundation for everything.

- **P0-T1** Scaffold the app (Next.js or Vite SPA), install deps, set up routing to match the sitemap (FE PRD §3). 🟢
- **P0-T2** Design tokens: color ramps, type scale (no <11px), spacing, radius; light/dark theming; fonts; base stylesheet. 🟢
- **P0-T3** App providers: theme context, **role context (stub)**, router, top-level error boundary. 🟢
- **P0-T4** **Fixture data foundation** — JSON fixtures matching real shapes: entity-registry (all 17, covering operating/developer/etf), `earnings.json` (several events incl. a beat, a miss, a developer catalyst, an ETF with no events, and at least one event with *pending* reaction horizons and a *partial* source window), `shared-state` (watchlist + custom sources + themes), `feedback-log`, sample `discover-feed` responses. 🟢
- **Exit:** app boots; every route resolves to a placeholder; theme toggles; fixtures load via a data hook.
- **Depends on:** nothing.

## Phase 1 — Global Shell & Navigation
**Goal:** the persistent frame and the ability to move around. (Parallelizable with Phase 2.)

- **P1-T1** Header bar: logo→Overview, top tabs (Overview / Sectors [hidden by flag] / Admin [role-gated]), account menu, theme toggle. 🟢
- **P1-T2** Role-conditional nav using the stub role context — Admin hidden for read-only. 🟢 (real auth in P9)
- **P1-T3** Global search box + typeahead against the fixture watchlist. 🟡 *live resolve of unknown tickers →* `/api/ticker-lookup`.
- **P1-T4** SecuritySwitcher + Breadcrumb components. 🟢
- **P1-T5** Persistence-status indicator + global banners (local-only, stale-refresh) — visual shells, wired in P3. 🟢
- **P1-T6** Footer disclaimer; FreshnessLegend popover; DataStatus pill (static until P12). 🟢
- **Exit:** navigate all placeholder routes via nav + search + switcher; toggling the stub role hides/shows Admin.
- **Depends on:** P0.

## Phase 2 — Component Library / Primitives
**Goal:** every reusable component from FE PRD §6, prop-driven, with all states, on a component-gallery page, from fixtures. (Parallelizable with Phase 1.)

- **P2-T1** Badges & indicators: `TypeBadge`, `FreshnessDot` (+tooltip), `ProvenanceChip`, `ArticleTypeBadge` (heuristic, $0), `LanguageBadge`, `SurprisePill`, `GuidanceMoveBadge`, `ExpectationTag`. 🟢
- **P2-T2** `FactPopover` (states: populated / manual / stale / absent) + **freshness-compute util** (pure function of `as_of` vs expected-refresh). 🟢
- **P2-T3** `ReactionChart` — sparkline + full variants; horizons d1/d3/w1/m1; states value / pending / gap-flagged; abs + excess; benchmark label. 🟢
- **P2-T4** `MetricRow`, `GuidanceTimeline`, `CatalystCard`. 🟢
- **P2-T5** `SourceItemCard` (**$0 layout: no summary line**) + group segmented control; `SourceUnavailableChip`; feedback affordances (thumbs / block / not-relevant) emitting callbacks (wired P6/P8). 🟢
- **P2-T6** ETF components: `DistributionRow`, `HoldingsTable`. 🟢
- **P2-T7** Utility/layout: `Table` (sortable/filterable/sticky/keyboard), `Modal`/`SlideOver`, `Toast`, `EmptyState`/`LoadingSkeleton`/`ErrorState`, `StalenessLegend`, `DeepLinkButton` (emits an open-source event). 🟢
- **Exit:** the gallery page renders every component in every state from fixtures.
- **Depends on:** P0 (tokens). Independent of P1.

## Phase 3 — Data Client & State Model
**Goal:** the seam between UI and data — fixtures now, live later, with the write/sync/freshness mechanics. Unblocks live wiring for P4–P8.

- **P3-T1** API-client wrappers per endpoint with a **fixtures-vs-live switch** (env flag). 🔴 live mode requires the backend endpoints.
- **P3-T2** Freshness recompute-at-read, incl. recompute-on-focus; integrate with `FreshnessDot`. 🟢
- **P3-T3** Optimistic-write layer + commit-pipe status (`Synced` / `Syncing…` / `Local only`) + localStorage merge-on-mount. 🟡 local works standalone; cross-device sync needs `/api/shared-state` + `GH_PAT`.
- **P3-T4** Conflict handling (409 → toast + auto-retry); local-only (503 → banner) wiring. 🟡
- **P3-T5** Pending-horizon + gap logic feeding `ReactionChart`. 🟢
- **Exit:** views read through the client; fixture mode fully functional; live mode compiles behind the flag.
- **Depends on:** P0; P2 (freshness util, toast/banner shells).

## Phase 4 — Watchlist Overview
**Goal:** the default landing table, assembled from primitives.

- **P4-T1** Table columns: name+`TypeBadge`, next event / days-until, last period, last surprise (`SurprisePill`), guidance move, reaction sparkline, freshness dot, sources count + "new since last view". 🟢 (fixtures)
- **P4-T2** Filter/sort bar: type filter, reporting-soon, sort (next event / surprise / reaction / freshness / name), group-by (type / sector). 🟢
- **P4-T3** Row states: recent-event highlight, data-incomplete, unscheduled, developer/ETF cell variants (type-aware). 🟢
- **P4-T4** Loading skeleton / empty (editor vs read-only) / error / partial states. 🟢
- **P4-T5** **Wire live.** 🔴 `/api/shared-state` (watchlist) + `/api/earnings` per ticker (latest-event summary + reaction + source count).
- **Exit:** overview renders all states from fixtures; live behind flag.
- **Depends on:** P1, P2, P3.

## Phase 5 — Security Detail (3 type variants)
**Goal:** the per-name page for operating / developer / etf.

- **P5-T1** Shell: breadcrumb, security header (name/type/listing/benchmark/sector chips/freshness/next-event; editor buttons), section nav. 🟢
- **P5-T2** **Operating** variant: latest-print panel (`MetricRow`×n incl. production), Events list, Guidance section (`GuidanceTimeline`), Reaction section (full `ReactionChart`), Sources section (stub feed → full in P6). 🟢
- **P5-T3** **Developer** variant: next-catalyst callout, Catalyst section (`CatalystCard`×n + `ExpectationTag`), Reaction, Sources. 🟢
- **P5-T4** **ETF** variant: price, distributions, holdings, "used as benchmark for"; friendly no-events state. 🟢
- **P5-T5** Type routing + states (data-incomplete, no-events). 🟢
- **P5-T6** **Wire live.** 🔴 `/api/earnings?ticker`.
- **Exit:** all three variants render from fixtures; reachable from Overview.
- **Depends on:** P2, P3, P4 (nav entry).

## Phase 6 — Event (Print) Detail
**Goal:** the core investigative view — numbers, reaction, and the commentary around one event.

- **P6-T1** Event header + **verdict-note** field (editor; autosave via P3 optimistic layer). 🟡 note persistence needs the store.
- **P6-T2** Numbers panel (operating `MetricRow`s + `GuidanceTimeline`; developer `CatalystCard`s). 🟢
- **P6-T3** Reaction panel (full `ReactionChart`, per-horizon value/pending/gap, baseline BMO/AMC note). 🟢
- **P6-T4** Sources panel: window indicator, group tabs (Official / News / Opinion / Social) with counts, `SourceItemCard` feed, per-engine status row + `SourceUnavailableChip`. 🟢 (renders from fixture snapshot)
- **P6-T5** "Refresh sources now" (editor). 🔴 `/api/news` + `/api/press-releases` + `/api/tweets`; progress + per-engine result; gate + dedup + append.
- **P6-T6** Feedback affordances wired. 🔴 `/api/feedback`.
- **P6-T7** States: pending reaction, empty-window, engine-partial. 🟢
- **P6-T8** **Wire live.** 🔴 event object from `/api/earnings`.
- **Exit:** event detail renders from fixtures incl. empty/partial/pending; live refresh gated on backend.
- **Depends on:** P2, P3, P5.

## Phase 7 — Source / Deep-Link Viewer
**Goal:** verify a number / read a captured item at its exact spot.

- **P7-T1** SlideOver/route container; opens via `DeepLinkButton` / `SourceItemCard` (event bus from P2). 🟢
- **P7-T2** **Hosted mode:** rendered doc + anchor highlight + segment nav; fallback-to-top notice. 🔴 hosted Document/Segment content.
- **P7-T3** **Link-out mode:** title/source/provenance + link-confirmation dialog → new tab. 🟡 resolved publisher URL from backend; degrades to raw fixture URL.
- **P7-T4** States: loading / hosted / link-out / source-dead / highlight-not-found. 🟢
- **Exit:** viewer opens from any sourced number/item; link-out works on fixtures; hosted needs backend content.
- **Depends on:** P2, P6 (and P5 for number click-through).

## Phase 8 — Admin Suite
**Goal:** configure coverage, enter the manual layer, manage sources and feedback.

- **P8-T1** Admin home + route guards (editor only; server-block relied upon in P9). 🟢
- **P8-T2** Add/Edit Security form: type-dependent fields, chip inputs (aliases/exclusion/sector), headline-metric multi-select (blocked if not in dictionary), benchmark validation, official-sources editor. Resolve 🔴 `/api/ticker-lookup`; save 🔴 registry write via persistence pipe.
- **P8-T3** Manual Value Entry: **mandatory source + as-of** validation, method select (`bloomberg_manual` / `filing_manual` — corrections / actuals read off a filing), supersede/versioning. Save 🔴 earnings/guidance store write.
- **P8-T4** Custom Sources: paste → Discover 🔴 `/api/discover-feed`; kind-detection UI (rss / site-filter / twitter / substack); scope selector; list/toggle/remove; persist 🔴 `/api/shared-state`.
- **P8-T5** Feedback tables (sources / keywords / items; adjust/remove). 🔴 `/api/feedback`.
- **P8-T6** Optimistic + commit-pipe status across all admin writes; 409/503 handling (from P3). 🟡
- **Exit:** every form is fully usable in fixture mode (validation, optimistic-local writes); live actions flagged.
- **Depends on:** P1 (role gate), P2 (forms/primitives), P3 (persistence).

## Phase 9 — Auth Gate & Roles
**Goal:** replace the stub role with a real gate.

- **P9-T1** Login view + sign-in control (SSO or access — `[NEEDS DECISION]`). 🔴 auth provider.
- **P9-T2** Replace stub role with real role; enforce read-only (hide admin in UI; rely on server-side block). 🔴
- **P9-T3** Unauthenticated redirect + blocked state. 🔴
- **Exit:** unauthenticated requests blocked; role drives nav + admin visibility.
- **Depends on:** P1 (role context), P8 (surfaces to gate). *Can be stubbed earlier; real gate lands here.*

## Phase 10 — Sector View (Phase-3 feature, flagged)
**Goal:** thematic grouping now; the LLM "read" is disabled in $0 mode.

- **P10-T1** Sector list (tags + member counts). 🟡 from registry `sectorTags`.
- **P10-T2** Sector detail (member mini-rows + recent-events feed). 🔴 `/api/earnings` per member.
- **P10-T3** SectorRead panel showing the **disabled-LLM** state ($0). 🟢
- **P10-T4** Feature flag OFF by default. 🟢
- **Exit:** reachable when the flag is on; disabled-read copy correct.
- **Depends on:** P4, P5.

## Phase 11 — Global States, Responsive & Accessibility
**Goal:** cross-cutting polish across all shipped views.

- **P11-T1** Skeleton / empty / error across every view; `SourceUnavailableChip` wherever an engine can fail; stale-refresh + local-only banners live. 🟢
- **P11-T2** Responsive: tablet column-collapse (row expander); mobile read-only (stacked cards, single-column detail, admin absent). 🟢
- **P11-T3** Keyboard nav (table arrows/Enter, Escape closes panels, focus-visible), ⌘K palette (optional). 🟢
- **P11-T4** Screen-reader labels on all badges/dots/pills; chart text/table alternative; reduced-motion; external-link confirm dialog everywhere. 🟢
- **Exit:** a11y + responsive pass on all shipped views.
- **Depends on:** P4–P8 (the views being polished).

## Phase 12 — Settings, Data Status & QA
**Goal:** operational surface + end-to-end verification.

- **P12-T1** Settings (theme, role display, feature flags incl. **LLM enrichment shown OFF**). 🟢
- **P12-T2** Data Status panel (last cron per stage, last commit time, per-ticker freshness summary, per-engine reachability). 🔴 backend metadata / probe.
- **P12-T3** End-to-end QA against journeys J1–J6 (FE PRD §8), fixture pass then live pass. 🟡
- **Exit:** journeys pass in both modes; ship v1.
- **Depends on:** most prior phases.

---

## Dependency Graph (summary)

```
P0 ──┬─► P1 ─┐
     │       ├─► P4 ─► P5 ─► P6 ─► P7
     ├─► P2 ─┤        │
     │       │        └─► P10
     └─► P3 ─┘
P1 + P2 + P3 ─► P8 ─► P9
P4..P8 ─► P11
(most) ─► P12
```

- **Parallelizable:** P1 and P2 can run at the same time (both need only P0). P3 can start once P2's freshness util + toast/banner shells exist.
- **Critical path to a usable read-only demo (fixtures):** P0 → P1/P2 → P3 → P4 → P5 → P6 → P7.
- **Admin path:** P8 needs P1+P2+P3; P9 (real auth) follows P8.
- **Deferrable:** P10 (feature-flagged) and P12-T2 can trail; P9 can be stubbed and finished late without blocking read views.

---

## Backend Dependency Register

Everything not listed here is 🟢 and buildable now on fixtures (the entire shell, all primitives, all view rendering, all validation, all client-side states). The items below are where the front end needs a backend output to *function live*; each runs in fixture mode until its dependency exists.

| Task(s) | Flag | Backend output needed | What breaks without it |
|---|---|---|---|
| P1-T3 | 🟡 | `/api/ticker-lookup` | Resolving an unknown ticker in search / Add-Security (known watchlist search still works) |
| P3-T1 | 🔴 | all read endpoints | Live data mode (fixtures unaffected) |
| P3-T3/T4 | 🟡 | `/api/shared-state` + `GH_PAT` | Cross-device sync of watchlist/sources/notes (local writes still work) |
| P4-T5 | 🔴 | `/api/shared-state`, `/api/earnings` | Live overview data |
| P5-T6 | 🔴 | `/api/earnings?ticker` | Live security detail data |
| P6-T5 | 🔴 | `/api/news`, `/api/press-releases`, `/api/tweets` | On-demand "refresh sources" (fixture snapshot still renders) |
| P6-T6 | 🔴 | `/api/feedback` | Persisting item/source feedback signals |
| P6-T8 | 🔴 | `/api/earnings` (event object) | Live event detail |
| P7-T2 | 🔴 | hosted Document/Segment content | Anchored in-app source view (link-out still works) |
| P7-T3 | 🟡 | resolved publisher URL (`_articleVerifier`) | Direct-to-article link (raw fixture URL degrades gracefully) |
| P8-T2 | 🔴 | `/api/ticker-lookup` + registry write | Resolving + saving a security live |
| P8-T3 | 🔴 | earnings/guidance store write | Persisting manual values |
| P8-T4 | 🔴 | `/api/discover-feed` + `/api/shared-state` | Discovering + saving custom sources |
| P8-T5 | 🔴 | `/api/feedback` | Feedback management |
| P9 | 🔴 | auth provider | Real sign-in + role enforcement (stub role unblocks all dev) |
| P10-T1/T2 | 🟡/🔴 | registry sector tags / `/api/earnings` per member | Sector membership + member data |
| P12-T2 | 🔴 | cron metadata / probe | Live Data Status panel |

**Bottom line:** Phases 0–2 (setup, shell, full component library) and the fixture-mode of Phases 3–8 require **zero backend** — the whole front end can be built, demoed, and reviewed first. The 🔴 rows are the exact, isolated points where the front end plugs into the backend outputs produced by project PRD Appendix C.
