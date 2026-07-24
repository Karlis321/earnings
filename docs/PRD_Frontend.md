# Front-End PRD — Earnings & Catalyst Dashboard

*Companion to `PRD_Earnings_Catalyst_Dashboard.md` (the project PRD). This document specifies the front end exhaustively: every view, every visible element, the component library, navigation, and end-to-end journeys. Where the project PRD defines what data exists and where it comes from, this defines what the analyst sees and does. Draft v1.0.*

*$0 / no-LLM mode (current): the app ships without the Anthropic enrichment. Consequence for the UI, applied throughout this document: source items show headline + source + provenance + a heuristic news/opinion badge + a language badge, but NO generated summary line and NO machine translation. The "summary" slot is hidden, not empty. Everywhere a summary would appear, the primary-source link is the fallback.*

## Table of Contents

1. [Purpose & Scope](#1-purpose--scope)
2. [Design Principles & Constraints](#2-design-principles--constraints)
3. [Information Architecture (Sitemap)](#3-information-architecture-sitemap)
4. [Navigation Structure & Flow](#4-navigation-structure--flow)
5. [Global Shell](#5-global-shell)
6. [Component Library](#6-component-library)
7. [Views](#7-views)
   - 7.1 Login / Auth Gate
   - 7.2 Watchlist Overview
   - 7.3 Security Detail — Operating
   - 7.4 Security Detail — Developer
   - 7.5 Security Detail — ETF
   - 7.6 Event (Print) Detail
   - 7.7 Source / Deep-Link Viewer
   - 7.8 Sector View (designed, Phase 3)
   - 7.9 Admin — Add / Edit Security
   - 7.10 Admin — Manual Value Entry
   - 7.11 Admin — Custom Sources
   - 7.12 Admin — Feedback & Source Signals
   - 7.13 Global States (loading / empty / error / offline)
   - 7.14 Settings
8. [User Journeys](#8-user-journeys)
9. [Interaction & State Model](#9-interaction--state-model)
10. [Responsive & Accessibility Spec](#10-responsive--accessibility-spec)
11. [Open Questions](#11-open-questions)

---

## 1. Purpose & Scope

The front end presents, for 17 covered securities, a self-refreshing and fully-sourced view of each name's earnings/catalyst events, how the stock reacted, and what was said around each event — with one click to the primary source for verification. It also provides the admin surfaces to configure coverage, enter the small manual data layer, and manage sources.

In scope: all read views (overview, security detail for the three security types, event detail, source viewer, sector view) and all editor views (add/edit security, manual entry, custom sources, feedback). Out of scope: the ingestion/cron internals (project PRD §6–9). Personal use; public URL by design; no auth surface.

**Single user (Karlis).** Every route is fully usable; no role split. All admin surfaces are always available.

---

## 2. Design Principles & Constraints

- **Desktop-first.** The analyst workflow is dense-table + detail on a wide screen. Mobile is a functional read view (overview + detail); admin/entry is desktop-only.
- **Every number is sourced and fresh.** No figure appears without (a) a freshness indicator and (b) a reachable provenance (source + as-of + method) on hover/expand. This is the single most load-bearing UI rule.
- **Type-aware rendering.** The security type (operating / developer / etf) changes which fields render. Developers never show "earnings/estimate/miss-beat"; ETFs never show events. This is enforced in the component layer, not per-page copy.
- **Honesty over completeness.** Unavailable data renders as an explicit "—" with a stale/absent flag, never as a blank cell or a fabricated value.
- **Plain English.** No jargon ("re-rate", "the drill bit"), short sentences, verdict-style phrasing.
- **Fail-soft, visibly.** A dead source shows an inline "source unavailable" chip; siblings still render. A vendor gap turns a freshness dot amber/red rather than hiding the field.
- **$0 / no-LLM.** No generated summaries or translations (see header note). Classification badges are heuristic.
- **Optimistic local + commit-pipe.** Editor writes update the UI immediately (localStorage), then sync to the repo via the GitHub commit-pipe (~1 min); the UI reflects "syncing" without blocking.

---

## 3. Information Architecture (Sitemap)

```
/login                         Auth gate (unauthenticated only)
/                              Watchlist Overview (default landing)
/s/:ticker                     Security Detail (operating | developer | etf variant by type)
/s/:ticker/e/:eventId          Event (Print) Detail
/s/:ticker/e/:eventId/src/:id  Source / Deep-Link Viewer (panel or route)
/sectors                       Sector list (Phase 3)
/sectors/:sectorId             Sector detail (Phase 3)
/admin                         Admin home (editor only)
/admin/securities/new          Add Security
/admin/securities/:ticker      Edit Security
/admin/entry/:ticker           Manual Value Entry
/admin/sources                 Custom Sources
/admin/feedback                Feedback & Source Signals
/settings                      Settings (theme, role display, data status)
```

Data bindings (which API each surface reads; see project PRD §9 / Appendix A):
- Overview & detail read `/api/earnings?ticker=…` (events, metrics, reaction, sources) + `/api/shared-state` (watchlist).
- Event sources read the snapshot embedded in `/api/earnings`; live "refresh sources" calls `/api/news`, `/api/press-releases`, `/api/tweets`.
- Security search/resolve uses `/api/ticker-lookup`.
- Custom sources use `/api/discover-feed`; feedback uses `/api/feedback`; watchlist/sources persist via `/api/shared-state`.

---

## 4. Navigation Structure & Flow

Primary navigation is a persistent top bar (see §5). The nav model is shallow: at most three levels deep (Overview → Security → Event), plus a modal/panel layer for the source viewer.

- **Top-level tabs:** Overview · Sectors (Phase 3, hidden until enabled) · Admin (editor only). Right side: global search, freshness legend toggle, theme toggle, role/account.
- **Lateral movement:** a security switcher (dropdown or ⌘K palette) lets the user jump between covered names without returning to Overview.
- **Drill-down:** Overview row → Security Detail → Event Detail → Source Viewer. Each level has a breadcrumb back.
- **Deep-link behavior:** clicking a sourced number anywhere opens the Source Viewer for that number's citation (hosted → anchored highlight; external → confirm dialog then new tab).
- **Back/stateful URLs:** every view is URL-addressable (§3) so a specific event or source is shareable within the team.

Flow diagram (happy path): `Login → Overview → (search or row click) → Security Detail → Event Detail → Source Viewer → back to Event/Detail`. Editor branch: `Overview/Detail → Admin → Add/Edit or Manual Entry → back`.

---

## 5. Global Shell

Present on every authenticated view.

- **Header bar:**
  - App title/logo (links to Overview).
  - Top-level tabs (Overview / Sectors / Admin) with active state.
  - Global search box — ticker or name; typeahead backed by the watchlist first, then `/api/ticker-lookup` for resolve; Enter navigates to `/s/:ticker` or opens Add-Security prefilled if unknown.
  - ⌘K command palette (optional P1): jump to security, jump to event, run "refresh sources".
  - Freshness legend toggle — opens a small popover explaining the RAG dots (green ≤ expected refresh, amber = overdue, red = stale/failed, "—" = never fetched).
  - Data-status pill — overall freshness of the last daily refresh + last-commit time ("Updated 06:04, 24 Jul"); click → Settings › Data Status.
  - Theme toggle (light/dark).
  - Account menu — role label (Editor / Read-only), sign out.
- **Persistence status indicator:** a small inline state near the header ("Synced" / "Syncing…" / "Local only") reflecting the commit-pipe (§9). In read-only mode this is hidden.
- **Global banners (conditional):**
  - Local-only mode (`GH_PAT` missing → writes stay local): amber banner "Changes are saved on this device only."
  - Stale daily refresh (cron hasn't run in > 1 trading day): amber banner with last-run time.
- **Footer:** disclaimer — "Decision-support tool. Not investment advice." + build version.

---

## 6. Component Library

Reusable components referenced by the views. Each lists its variants and states.

- **TypeBadge** — `operating` / `developer` / `etf`. Color-coded, always paired with a label (never color alone).
- **FreshnessDot** — RAG + "—". Tooltip: as-of, fetched-at, expected-refresh. Never appears without an adjacent value.
- **ProvenanceChip** — `regulatory` / `ir-page` / `wire` / `news` / `social` / `independent`. Small pill next to a source or item.
- **FactPopover** — anchored to any sourced number. Shows: value + unit, source label + link, `as_of`, `fetched_at`, `method` (yahoo / fmp / bloomberg_manual / filing_manual), confidence, and a "View source" deep-link button. States: populated, manual (badge), stale (amber header), absent ("No source on file").
- **SurprisePill** — beat (+x.x%) / miss (−x.x%) / inline / "n/a — no estimate". Green/red/neutral, with sign. Hidden for developers and ETFs.
- **GuidanceMoveBadge** — raised / held / cut / initiated / withdrawn. Hidden for developers/ETFs.
- **ExpectationTag** (developer) — below / inline / above / unset. Analyst-set; editable inline in admin.
- **ReactionChart** — the 4-horizon reaction (d1/d3/w1/m1). Shows abs + excess vs benchmark. States per horizon: value, "pending — populates <date>", "gap-flagged". Small sparkline variant for the overview row; full bar/line variant on detail. Benchmark name shown.
- **MetricRow** — canonical metric label + estimate + actual + SurprisePill + FreshnessDot; estimate/actual each open a FactPopover.
- **GuidanceTimeline** — versioned guidance entries (newest first), each with range, period, basis, GuidanceMoveBadge, as-of, source link; superseded versions shown collapsed.
- **CatalystCard** (developer) — catalyst type icon + title + expected/actual date + ExpectationTag + key values (e.g., resource tonnes, drill intercept, NPV/IRR) + source link.
- **SourceItemCard** — for an event's source snapshot: headline (links out via viewer), source name, ProvenanceChip, ArticleTypeBadge, LanguageBadge, timestamp, engine tag, and (tweets) engagement counts. NO summary line in $0 mode.
- **ArticleTypeBadge** — news / opinion (heuristic in $0 mode: derived from source tier + headline pattern; tooltip notes "heuristic"). 
- **LanguageBadge** — shows "PT" etc. when the item isn't English (replaces the removed auto-translation); English items show no badge.
- **DeepLinkButton** — "View source". Hosted → opens Source Viewer scrolled to anchor; external → link-confirmation dialog then new tab.
- **DistributionRow / HoldingsTable** (ETF) — ex-date + amount + yield; top holdings + weights + as-of.
- **StalenessLegend** — the RAG key (popover).
- **EmptyState / LoadingSkeleton / ErrorState / SourceUnavailableChip** — standard blocks (see §7.13).
- **Toast** — save success / conflict-retry / error.
- **Modal / SlideOver** — used by the Source Viewer and admin forms.
- **Table** — sortable, filterable; sticky header; keyboard navigable.
- **Breadcrumb**, **SecuritySwitcher**, **SearchTypeahead**.

---

## 7. Views

Each view below lists: purpose, layout, every visible element, states, interactions, data binding, and notes. Responsive/a11y consolidated in §10.

### 7.1 Login / Auth Gate
- **Purpose:** N/A for personal use. Kept as a UI placeholder — the app runs open. Delete this route if you want.
- **Elements:** app title, sign-in control (SSO button or access-code field per `[NEEDS DECISION]` in project PRD §M1), error line, footer disclaimer.
- **States:** idle, submitting, auth error, blocked (not authorized).
- **Interactions:** successful auth → redirect to Overview with role set; failure → inline error, no navigation.
- **Data:** auth provider (TBD). No app data loads until authenticated.

### 7.2 Watchlist Overview
- **Purpose:** one screen to scan the whole book; the default landing.
- **Layout:** header (§5) + filter/sort bar + dense table + footer. Optional grouping toggle (by type or by sector tag).
- **Elements — filter/sort bar:** search-within-list, type filter (all/operating/developer/etf), "reporting soon" filter (next event ≤ N days), sort control (next event / last surprise / last reaction / freshness / name), group-by toggle, "refresh status" affordance (read-only view of last cron run; editors may trigger a manual refresh if enabled).
- **Elements — table columns:**
  - Name + ticker (+ TypeBadge).
  - Next event — date + days-until, OR "unscheduled" flag; developers show catalyst label; ETFs show "—".
  - Last event period.
  - Last surprise — SurprisePill (operating only; developer shows ExpectationTag; ETF "—").
  - Guidance move — GuidanceMoveBadge (operating only).
  - Reaction — compact ReactionChart sparkline (d1/d3/w1/m1) with pending markers.
  - Freshness — FreshnessDot for the row's most-stale P0 field.
  - Sources — count of items in the latest event's snapshot + a "new since you last viewed" indicator.
- **Row states:** normal, has-recent-event (highlight badge), data-incomplete (amber), unscheduled, developer/ETF variants.
- **Interactions:** row click → Security Detail; column sort; hover a cell number → FactPopover; click a sparkline horizon → Event Detail scrolled to reaction; keyboard up/down + Enter.
- **States:** loading skeleton rows; empty ("No securities yet — add one" for editors, plain empty for read-only); partial (some rows data-incomplete); error (table-level with retry).
- **Data:** `/api/shared-state` (watchlist order + coverage) joined with `/api/earnings` per ticker (latest event summary + reaction + source count).

### 7.3 Security Detail — Operating
- **Purpose:** full end-to-end view of one operating name.
- **Layout:** breadcrumb + security header + tabbed or stacked sections: Overview · Events · Guidance · Reaction · Sources. SecuritySwitcher in header.
- **Elements — security header:** name, ticker, TypeBadge, listing/exchange, currency, assigned benchmark, sector tags (chips), overall FreshnessDot, "next event" callout, (editor) "Edit security" + "Manual entry" buttons.
- **Elements — Events section:** reverse-chronological list of events; each row = period + date + timing (BMO/AMC) + headline metric SurprisePill + GuidanceMoveBadge + mini ReactionChart; click → Event Detail.
- **Elements — latest-print panel (top of Events):** MetricRow per headline metric (estimate/actual/surprise/freshness, each Fact-linked); production shown as a headline MetricRow like any other; GuidanceMoveBadge.
- **Elements — Guidance section:** GuidanceTimeline (versioned).
- **Elements — Reaction section:** full ReactionChart (4 horizons, abs + excess vs benchmark), benchmark label, per-horizon pending/gap states, baseline note (BMO/AMC anchor).
- **Elements — Sources section:** the latest event's SourceItemCard feed (see 7.6) with group tabs (Official / News / Opinion / Social); "view all events' sources" link.
- **States:** loading, fully-populated, data-incomplete (per-field flags), no-events-yet ("No events recorded"), source-engine-partial (chips).
- **Interactions:** section nav; any number → FactPopover → DeepLinkButton; event row → Event Detail; switch security.
- **Data:** `/api/earnings?ticker` (events/metrics/guidance/reaction/sources), registry (`getEarningsConfig`, sector tags, benchmark).

### 7.4 Security Detail — Developer
- **Purpose:** same shell, catalyst-oriented (pre-revenue; no EPS/consensus).
- **Differences from 7.3:**
  - No MetricRow estimate/actual/SurprisePill; no GuidanceMove.
  - "Next expected catalyst" callout (type + window), never "next earnings".
  - Catalyst section: CatalystCard list (drill result / resource / PEA / PFS / FS / permit / financing / M&A) with ExpectationTag and key values, source-linked.
  - Reaction section identical (reaction is measured against catalysts).
  - Sources section identical.
- **States/interactions/data:** as 7.3, minus earnings fields; registry `catalystTypes` drives the catalyst type set.

### 7.5 Security Detail — ETF
- **Purpose:** price + distributions + holdings; no events.
- **Elements:** security header (as above, benchmark n/a or self); Price section (last close + FreshnessDot + small history spark); Distributions section (DistributionRow list: ex-date, amount, yield); Holdings section (HoldingsTable: top holdings, weights, as-of); "used as benchmark for" list (which operating/developer names reference this ETF).
- **Notably absent:** Events, Metrics, Guidance, Reaction, Sources (no event snapshot). If a user reaches an event URL for an ETF, show a friendly "ETFs don't have events" empty state.
- **Data:** `/api/earnings?ticker` returns the ETF price/distribution/holdings shape (no events).

### 7.6 Event (Print) Detail
- **Purpose:** the core investigative view — one event with its numbers, reaction curve, and the commentary captured around it. This is where "did it beat, and why did the stock move" is answered.
- **Layout:** breadcrumb (Security › Event) + event header + three stacked panels: Numbers · Reaction · Sources.
- **Elements — event header:** period, event date, timing (BMO/AMC), kind (earnings/catalyst), a one-line verdict slot (analyst-editable note, not LLM), FreshnessDot.
- **Elements — Numbers panel (operating):** MetricRow per metric (headline flagged first); each estimate/actual opens FactPopover with source link; GuidanceTimeline for this period; production as a MetricRow. Developer variant: CatalystCard(s) + ExpectationTag.
- **Elements — Reaction panel:** full ReactionChart with the four horizons; each horizon shows abs return, excess vs benchmark, the benchmark used, and computed-at; pending horizons show the date they'll populate; gap-flagged horizons explain why. Baseline anchor note.
- **Elements — Sources panel (the "why"):**
  - Window indicator ("Sources T−2 … T+35", captured-at).
  - Group tabs / segmented control: Official · News · Opinion · Social (counts per group).
  - SourceItemCard list per group: headline (→ Source Viewer), source, ProvenanceChip, ArticleTypeBadge (heuristic), LanguageBadge (if non-EN), timestamp, engine tag; tweets show engagement.
  - Per-source-engine status row: which engines were reachable during the window; a SourceUnavailableChip for any that failed (e.g., "X unavailable — proxy down").
  - (Editor) "Refresh sources now" button → live poll of `/api/news` + `/api/press-releases` + `/api/tweets` for this ticker/window, gated + appended; shows progress and per-engine result.
  - Feedback affordance per item: thumbs up/down (→ `/api/feedback` signal), "block this source", "not relevant" (drops from view, records signal).
- **States:** loading; fully-populated; sources-empty-in-window ("No commentary captured in this window"); engine-partial; pending-reaction; developer/ETF variants.
- **Interactions:** item click → Source Viewer; number → FactPopover; refresh sources; feedback signals; editable verdict note (editor) autosaves via shared-state.
- **Data:** the event object from `/api/earnings` (metrics/guidance/reaction/sources); live refresh via the three source endpoints.

### 7.7 Source / Deep-Link Viewer
- **Purpose:** verify a number or read a captured item at its exact spot in the primary source.
- **Presentation:** slide-over panel (preferred) or full route; opened by any DeepLinkButton / SourceItemCard.
- **Two modes:**
  - **Hosted (company-posted transcript / press release / EDGAR-SEDAR filing):** rendered document with the cited paragraph scrolled-to and highlighted (the annotation anchor). Header: document type, source label, ProvenanceChip, date, "Open original" external link. Segment navigation (prepared remarks / Q&A) for transcripts.
  - **Link-out (third-party):** NOT rehosted. Shows title, source, ProvenanceChip, timestamp, and a link-confirmation dialog → opens the publisher URL in a new tab (via the host link dialog). Explains "opens the original in a new tab."
- **Elements:** header (type, source, provenance, date), body (hosted content w/ highlight OR link-out card), pinpoint quote (≤15 words / paraphrase) when present, close/back, copy-link.
- **States:** loading; hosted-rendered; link-out; source-dead ("Original no longer reachable — last seen <date>"); highlight-not-found (falls back to top of doc with a notice).
- **Data:** hosted content from the stored Document/Segment; link-out uses the resolved publisher URL (via `_articleVerifier` resolution). No LLM.

### 7.8 Sector View (designed, Phase 3)
- **Purpose:** thematic grouping and, later, a "vibe + forward" read. Designed now so the nav/layout exists; the read itself is Phase 3.
- **Elements — sector list (`/sectors`):** thematic tags (from registry `sectorTags`) with member counts; click → sector detail.
- **Elements — sector detail (`/sectors/:id`):** member securities (mini rows: name, last surprise, last reaction), an aggregate "recent events in this sector" feed, and a SectorRead panel (as-of, vibe, forward, staleness) — in $0/no-LLM mode this panel shows "Sector reads require the LLM feature (disabled)" rather than generated text; the member feed still works.
- **States:** enabled/disabled (feature flag), populated, empty.
- **Data:** registry sector tags + `/api/earnings` per member; SectorRead when enabled.

### 7.9 Admin — Add / Edit Security (editor only)
- **Purpose:** register/configure a covered security (registry + earnings extension).
- **Elements — form fields:** ticker (Bloomberg-style), resolve button (→ `/api/ticker-lookup` fills name/exchange), display name, legal name, aliases (chip input), exclusion aliases (chip input), cashtag, sector tags (chip/select), `isCore` toggle, **securityType** (operating/developer/etf) — this toggles the fields below, **headlineMetrics** (multi-select from the canonical dictionary; blocked if a key isn't in the dictionary — with "add to dictionary" affordance), **benchmark** (ticker; validated), **catalystTypes** (developer only), official sources editor (list of `{kind,url,provenance,label}` rows; kind ∈ edgar/rss/mziq/html-*), X handle (optional).
- **Validation & states:** ticker unresolvable → warning + save as "data-incomplete"; no benchmark → block; free-form metric key → block with add-to-dictionary; type change re-renders dependent fields.
- **Interactions:** resolve, add/remove chips, add/remove source rows, save (optimistic + commit-pipe), delete (confirm).
- **Data:** reads/writes the entity registry (via the persistence pipe); `/api/ticker-lookup` for resolve.

### 7.10 Admin — Manual Value Entry (editor only)
- **Purpose:** enter the small Bloomberg-sourced layer (e.g., small-cap consensus) with mandatory sourcing.
- **Elements:** ticker + period selector; metric selector (from the security's headline metrics); value + unit; **source (required)**; **as-of (required)**; method (bloomberg_manual / filing_manual — for a correction or an actual read off a filing); confidence (optional); note. A running list of manual values for this ticker with edit/supersede.
- **Validation & states:** save blocked if source or as-of missing (inline error, nothing persists); saved value gets a manual badge + ledger line; supersede creates a new version (does not overwrite).
- **Interactions:** save (optimistic + commit-pipe), supersede, delete (confirm).
- **Data:** writes Fact entries into the event/guidance store; appends to `_ledger`.

### 7.11 Admin — Custom Sources (editor only)
- **Purpose:** add a source by pasting any URL; scope it to tickers/themes.
- **Elements:** URL paste field + "Discover" button (→ `/api/discover-feed`); discovery-result card showing the detected kind (RSS feed / site-filter / Twitter account / Substack publication / Substack notes) with an explanatory note; scope selector (which tickers/themes this source feeds); label; save. List of existing custom sources with kind chip, scope, last-fetch status, enable/disable, remove.
- **States:** discovering, discovered (per kind), no-feed-found (falls back to site-filter with note), invalid/blocked URL (private-host rejection), major-news-host (auto site-filter note).
- **Interactions:** discover, adjust scope, save, toggle, remove; feeds persist via shared-state `customSources`.
- **Data:** `/api/discover-feed`, `/api/shared-state`.

### 7.12 Admin — Feedback & Source Signals (editor only)
- **Purpose:** review and manage the durable feedback that tunes source/keyword/item quality.
- **Elements:** three tables — Sources (name, signal +/−, count, updated), Keywords (keyword, signal, count), Items (url, signal, reason, ts). Filters + search; clear/adjust a signal; export.
- **States:** loading, populated, empty, local-only (if `GH_PAT` absent → 503 → banner).
- **Interactions:** adjust/remove a signal (optimistic + commit-pipe), open an item URL.
- **Data:** `/api/feedback` (GET/PUT).

### 7.13 Global States (loading / empty / error / offline)
- **Loading:** skeletons matching final layout (rows, cards, chart placeholders). Never a blank screen.
- **Empty:** contextual copy + (editor) a primary action; (read-only) plain message. Distinguish "no data yet" from "no data in this window."
- **Error:** view-level error block with retry; per-component ErrorState for isolated failures (a failed source engine never blanks the whole event).
- **SourceUnavailableChip:** inline where a specific engine/source failed, with last-good time.
- **Offline / local-only:** banner (§5); writes queue locally and reconcile on reconnect/commit.
- **Stale-refresh:** amber banner if the daily cron hasn't run within a trading day.
- **Conflict (409):** toast "Someone else saved first — refreshing and retrying" then auto-retry.

### 7.14 Settings
- **Elements:** theme (light/dark/system), role display (read-only info), Data Status panel (last cron run per stage, last commit time, per-ticker freshness summary, per-source-engine reachability from the last probe), feature flags visible to editors (Sectors on/off, LLM enrichment on/off — shown OFF in $0 mode), disclaimer + version.
- **Data:** aggregated freshness + last-run metadata; `/api/_probe` style reachability if exposed.

---

## 8. User Journeys

Numbered, cross-view, each with decision points and at least one error/edge.

### J1 — Morning scan of the book (read-only or editor)
1. Sign in → Overview.
2. Scan for recent-event highlights and amber freshness dots.
3. Sort by "last surprise" or "reporting soon."
   - **Edge:** stale-refresh banner shows the cron didn't run → user knows figures may lag; freshness dots corroborate per-row.
4. Click a name with a fresh print → Security Detail.

### J2 — Investigate a print and why it moved (core loop)
1. Security Detail → Events → click the latest event → Event Detail.
2. Read Numbers panel: beat/miss per headline metric; open a FactPopover; **decision:** trust or verify.
3. Verify → DeepLinkButton → Source Viewer opens at the exact paragraph (hosted) or confirms then opens the publisher (link-out).
4. Read Reaction panel: +1d/+3d/+1w; **decision:** the move looks anomalous (excess ≫ 0).
5. Read Sources panel to find "why": switch to News/Opinion/Social tabs.
   - **Edge:** +1m still "pending"; sources for the later window still accruing → the panel says so rather than implying nothing happened.
   - **Edge:** the X engine shows a SourceUnavailableChip (proxy down) → user sees the gap, uses the other groups.
6. (Editor) jot a one-line verdict note; it autosaves (syncing indicator).

### J3 — Onboard a new covered name (editor)
1. Admin → Add Security → enter ticker → Resolve.
   - **Edge:** ticker unresolvable (e.g., an obscure listing) → warning; save as data-incomplete; add a manual/official source instead.
2. Set securityType → dependent fields render; pick headline metrics (blocked if a key isn't in the dictionary → add it); set benchmark; add official sources.
3. Save → optimistic add to Overview with a data-incomplete flag until the next cron populates it.

### J4 — Enter a manual consensus value (editor)
1. Admin → Manual Entry → pick ticker/period/metric.
2. Enter value + unit; **must** add source + as-of.
   - **Edge:** submit without source → blocked inline; nothing persists.
3. Save → value shows a manual badge on the Event Detail; ledger line appended.

### J5 — Add a custom source (editor)
1. Admin → Custom Sources → paste a Substack/publisher URL → Discover.
   - **Decision/branch:** RSS found → save as feed; no RSS → site-filter fallback with note; X/Substack profile → account/publication path; private host → rejected.
2. Scope it to tickers/themes → Save. It begins feeding the relevant event source windows on the next poll.

### J6 — Mobile read skim
1. Sign in (read-only) → Overview (mobile layout).
2. Tap a name → Security Detail (read view): latest surprise, guidance move, reaction, top sources.
   - **Edge:** admin actions are absent entirely (not just disabled).

---

## 9. Interaction & State Model

- **Freshness is computed at read time**, never stored — every render recomputes each field's RAG from `as_of` vs its expected-refresh window. A page left open recomputes on focus.
- **Pending reaction horizons** are first-class UI: a horizon that hasn't elapsed shows "pending — populates <date>", not blank or zero.
- **Optimistic writes + commit-pipe latency:** editor actions update localStorage and the UI immediately; a "Syncing…" indicator tracks the GitHub commit (~1 min); on success → "Synced". The client treats localStorage as immediate truth and merges the server snapshot on mount.
- **Conflict handling:** a `409` (stale SHA) surfaces as a toast and auto-retry after refreshing the base state.
- **Local-only degradation:** if the persistence pipe is unavailable (`503`, no `GH_PAT`), writes remain local; a persistent banner explains it; nothing is lost, but cross-device sync is paused.
- **Fail-soft rendering:** each source engine renders independently; one failing engine yields a chip, not a blank panel.
- **No-LLM slots:** summary lines are removed (not shown empty); article-type and language are heuristic badges; sector reads show a disabled-feature note.
- **Deep-link resolution:** external links always pass through the host link-confirmation dialog; hosted docs render with an anchor highlight, falling back to top-of-doc with a notice if the anchor is missing.

---

## 10. Responsive & Accessibility Spec

- **Breakpoints:** desktop (primary, dense table + multi-panel detail), tablet (table collapses secondary columns behind a row-expander), mobile (read-only: Overview becomes stacked cards; Security/Event Detail single-column; admin hidden).
- **Density:** overview is intentionally dense on desktop; row height and font stay legible (no < 11px text).
- **Keyboard:** full keyboard nav on the table (arrow/enter), command palette (⌘K), focus-visible rings, escape closes panels/modals.
- **Screen readers:** every FreshnessDot, ProvenanceChip, SurprisePill, and badge has a text label (color is never the only signal); charts expose a text/table alternative; the Source Viewer announces "opening original in new tab."
- **Contrast:** legible in light and dark; staleness pairs color with an icon/label.
- **Motion:** minimal; respect reduced-motion.
- **Link safety:** all external navigation via the confirmation dialog.

---

## 11. Open Questions

Inherited and front-end-specific `[NEEDS DECISION]` items:
- Auth provider and whether sign-in is SSO vs access list (drives 7.1).
- Whether Event Detail is a route or a slide-over from Security Detail (both specced; pick one for consistency).
- Source Viewer: slide-over vs full route (7.7).
- Heuristic news/opinion rules for the ArticleTypeBadge in $0 mode — exact source-tier + headline-pattern list (needs sign-off; currently "heuristic" tooltip).
- Overview grouping default (by type vs by sector vs flat).
- Whether editors can trigger a manual on-demand refresh from the UI, or refresh is cron-only (affects 7.2/7.6 buttons + rate-limit exposure).
- ⌘K command palette in v1 or P1.
- Mobile scope: read-only Overview + Detail only, or also Event Detail sources (7.6 on mobile).
- Sector view enable timing (Phase 3 flag) and the disabled-state copy.
- Verdict-note field: per-event free text stored where (shared-state vs earnings.json).
