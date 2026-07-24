# Product Requirements Document — Earnings & Catalyst Dashboard

*Personal earnings-tracking dashboard. Draft v0.3 (rebranded from an earlier internal-tool framing).*

> **Deltas from earlier drafts** — see `docs/PRD_Backend.md §2` for the full decision list. Applied throughout this document:
> - **No authentication** (personal use, public URL by design). §M1 no longer applies.
> - **No Cloudflare Worker.** Vercel-only egress. X posts via Nitter are dropped; TwitterAPI.io stays *optional*. Mentions of `TWEET_WORKER_URL` / `TWEET_WORKER_SECRET` / "Cloudflare Worker proxy" in this document apply to the reference architecture only — they are NOT wired into this build.
> - **No Bloomberg redistribution concern** — all data ingested is publicly available.
> - **Persona collapsed** to a single user (Karlis).

*v0.2 note: the project reuses the proven API connections from a reference news-tracker codebase. Section 9 and Appendices A–B document those connections in port-ready detail so the new build replicates them exactly rather than rediscovering each vendor quirk.*

*v0.3 note: Appendix C turns this document into a build guide a coding agent (Claude Code) can execute. It gives the repo scaffold, a root `CLAUDE.md` starter, the env-var manifest, the module contracts (function signatures + return shapes) for every connection, the v1 JSON snapshot shapes, and an ordered, dependency-aware task list with per-task acceptance checks. Appendices A–B supply the vendor specifics each module needs; Appendix C says which module owns which connection and in what order to build them. (The standalone `CLAUDE.md` + `schema.prisma` shared earlier are superseded for v1 by Appendix C's git-snapshot approach; the Prisma schema remains the Postgres upgrade path.)*

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals & Success Metrics](#2-goals--success-metrics)
3. [User Personas](#3-user-personas)
4. [Feature Requirements](#4-feature-requirements)
5. [User Flows](#5-user-flows)
6. [Data Model & Architecture](#6-data-model--architecture)
7. [Technical Considerations](#7-technical-considerations)
8. [UI/UX Specifications](#8-uiux-specifications)
9. [Integration Details](#9-integration-details)
10. [Monetization & Plan Tiers](#10-monetization--plan-tiers)
11. [Open Questions & Risks](#11-open-questions--risks)
12. [Future Roadmap](#12-future-roadmap)
- [Appendix A — Reusable Connection Cookbook](#appendix-a--reusable-connection-cookbook)
- [Appendix B — Source Quality & Entity-Matching Utilities](#appendix-b--source-quality--entity-matching-utilities)
- [Appendix C — Build Guide for Claude Code](#appendix-c--build-guide-for-claude-code)

---

## 1. Executive Summary

The Earnings & Catalyst Dashboard is a personal tool that tells the user, for every covered name, when it reports, whether it beat or missed, how guidance moved, what management said, and how the stock reacted — with a one-click path to the exact spot in the primary source so any number can be verified without leaving the app. The value proposition is a single, always-current, fully-sourced view that turns a multi-hour manual gathering exercise into a glance, while preserving the discipline of tracing every number back to its filing. Version 1 covers a configurable watchlist (17 seed names in fixtures); later phases extend to a shallow S&P 500 / EuroStoxx headline scan and sector-level "vibe and forward" reads. Because a book can span producers, pre-revenue developers, and index ETFs, the product models three distinct security types rather than forcing everything into an "earnings" mold.

---

## 2. Goals & Success Metrics

Primary goal: replace the manual, season-by-season gathering of earnings/catalyst information for covered names with a self-refreshing, verifiable dashboard.

| KPI | Target | Notes |
|---|---|---|
| Source traceability | 100% of displayed headline numbers have a working link to their primary source | Core, non-negotiable |
| Reaction completeness | All four reaction horizons (+1d/+3d/+1w/+1m) filled within ~23 trading days of every event | Core |
| Commentary retention | For every event, the windowed source snapshot (~T−2 to T+35 calendar days) is captured before recency-decay removes it | Core — see §6 EventSourceSnapshot |
| Calendar accuracy | ≥90% of scheduled earnings dates captured before the event date | *[ASSUMPTION]* |
| Data freshness | 100% of P0 fields for the 17 names show "green" staleness on any trading day | *[ASSUMPTION]* |
| Coverage honesty | 100% of unavailable fields shown as explicit null + staleness flag (never blank or guessed) | Core |
| Analyst prep time | Reduce time to prepare a single-name earnings check from ~30 min to <2 min | *[ASSUMPTION — baseline unmeasured]* |
| Regular use | Dashboard opened ≥3×/week during earnings season | *[ASSUMPTION]* |

All targets marked *[ASSUMPTION]* are proposed defaults and must be confirmed. `[NEEDS DECISION]`: which of these KPIs are actually tracked, and how baseline analyst-prep time is measured.

---

## 3. User Persona

**Karlis — sole user (analyst + maintainer).**
- Role: builds his own investment research; owns coverage of a personal watchlist. Same person operates the manual-entry surface (small-cap consensus, NAV values entered from any terminal he has access to).
- Pain point: every earnings season he manually reassembles report dates, consensus, actuals, guidance, production, and price reaction across filings, transcripts, and vendor sources — slow, repetitive, and easy to let a number go stale. Manual entry is where staleness creeps in and where sourcing discipline breaks.
- Gains: a single current view per name; instant beat/miss and guidance-move read; one click to the exact transcript paragraph to verify; accumulated history he never has to rebuild; a structured admin entry surface that forces source + as-of on every manual value, so the ledger stays intact.

*(Earlier drafts split this into Analyst / CIO / Data-Maintainer personas — collapsed for personal use.)*

---

## 4. Feature Requirements

Grouped by component. Priority: **P0** = MVP (the 17, deep) · **P1** = v1.1 · **P2** = future.

### A. Coverage & Watchlist Management

**A1. Add/configure a covered security**
- Description: register a ticker, assign its type (operating / developer / etf), coverage depth (deep / headline), listing, currency, and assigned reaction benchmark.
- User Story: As the analyst, I want to enter a ticker and its type so that the app applies the correct data flow (earnings vs catalyst vs none).
- Acceptance Criteria:
  - Given a valid ticker and type, when saved, the security appears in the watchlist with its type badge.
  - Given type = developer, then no "next earnings / estimate" fields are requested or shown for it.
  - Given no benchmark is assigned, then a validation warning is shown before save.
- Priority: P0
- Dependencies: Data model (Security); F (benchmark list).
- Open Questions: `[NEEDS DECISION]` canonical ticker format per venue (e.g. `RIO.PA`, `SCMI.CN`, `GDXJ` NYSE Arca line vs Borsa) — needs a resolution table.

**A2. Per-ticker BRIEF (company-specific instructions)**
- Description: a per-security `BRIEF.md`-style record holding headline-metric mapping, benchmark, primary-source URLs, and any manual notes.
- User Story: As the analyst, I want per-name instructions so that ingestion and display behave correctly for that specific company.
- Acceptance Criteria:
  - Given a saved BRIEF, when the security detail loads, its declared headline metrics render in order.
  - Given a BRIEF lists a primary-source domain, then documents from that domain are eligible for hosting.
- Priority: P0
- Dependencies: E (metric catalog); G (documents).
- Open Questions: none.

### B. Earnings & Catalyst Calendar

**B1. Next expected event**
- Description: show the next earnings date (operating) or next expected catalyst (developer), with estimates where they exist.
- User Story: As the analyst, I want to see what's coming next per name so that I can plan review time.
- Acceptance Criteria:
  - Given an operating name, when FMP returns a scheduled earnings date, it is displayed with days-until.
  - Given a developer name, then the field is labeled "next expected catalyst" and shows type + expected window, never "earnings."
  - Given no date is available, then the field shows "unscheduled" with a staleness flag, not a blank.
- Priority: P0
- Dependencies: I (ingestion); Data model (Event).
- Open Questions: `[NEEDS DECISION]` developer catalyst dates are analyst-entered (no feed) — confirm source-of-truth and update cadence.

### C. Results Capture & Miss/Beat

**C1. Actual vs estimate (surprise)**
- Description: on a print, capture actuals per headline metric, compare to estimate/consensus, compute surprise %.
- User Story: As the analyst, I want beat/miss computed automatically so that I don't hand-calculate surprise.
- Acceptance Criteria:
  - Given an estimate and an actual for the same canonical metric and period, then surprise % = (actual − estimate) / |estimate|, rounded to 1 dp.
  - Given only an actual (no estimate), then surprise shows "n/a — no estimate" not 0%.
  - Given a developer security, then this feature is not available (no estimates exist).
- Priority: P0
- Dependencies: E (canonical metrics); H (Fact provenance).
- Open Questions: `[NEEDS DECISION]` when both consensus and single-estimate exist, which is the beat/miss denominator?

### D. Guidance Tracking

**D1. Versioned guidance + move classification**
- Description: store guidance ranges per metric/period with version history; classify each update as raised / held / cut / initiated / withdrawn.
- User Story: As the analyst, I want guidance changes tracked over time so that I can see the trajectory, not just the latest number.
- Acceptance Criteria:
  - Given a new guidance value that supersedes a prior one, then a new version row is created and the prior is marked superseded (not overwritten).
  - Given a higher midpoint than the prior version, then the move is classified "raised."
  - Given the guidance detail view, then every version is visible with its as-of and source link.
- Priority: P0
- Dependencies: H (Fact); G (documents).
- Open Questions: none.

### E. Production & Metric Catalog

**E1. Canonical metric dictionary + per-company mapping**
- Description: a shared dictionary of canonical metric keys with fixed units; each company maps its headline metrics to canonical keys.
- User Story: As the analyst, I want production and other metrics under shared keys so that names can be compared and aggregated by sector.
- Acceptance Criteria:
  - Given two operating names both mapping to `production_cu_kt`, then a sector view can sum/compare them without unit conversion.
  - Given a metric not in the dictionary, then saving is blocked until the key is added to the dictionary (no free-form keys).
  - Given `eps_usd`, then an `is_adjusted` flag is required.
- Priority: P0
- Dependencies: A2 (BRIEF); J (sector, consumes it).
- Open Questions: `[NEEDS DECISION]` starter dictionary contents and unit conventions require sign-off.

### F. Price & Reaction Engine

**F1. Multi-horizon reaction (abs + excess)**
- Description: for each event, compute price reaction at +1d, +3d, +1w (trading days), as absolute return and excess vs assigned benchmark.
- User Story: As the analyst, I want to see how the stock moved after the print over several horizons so that I can judge the market's verdict.
- Acceptance Criteria:
  - Given an event with a defined baseline close, then abs return at +1d = (close(+1d) − baseline) / baseline.
  - Given an assigned benchmark, then excess = security return − benchmark return over the same window.
  - Given a horizon that has not yet elapsed, then it shows "pending" with the date it will populate.
  - Given a benchmark price gap, then the affected horizon is flagged, not silently computed on partial data.
- Priority: P0
- Dependencies: I (prices); A1 (benchmark).
- Open Questions: `[NEEDS DECISION]` baseline anchor — for a before-market-open (BMO) report, day-0 close vs prior close; for after-market-close (AMC), the next session. This must be defined per timing.

### G. Management Commentary & Primary-Source Deep-Link

**G1. Document ingest (transcript / press release / MD&A / filing)**
- Description: ingest a primary-source document, split transcripts into speaker/section/paragraph segments with stable anchors.
- User Story: As the analyst, I want the source document held with addressable paragraphs so that I can link a number to its exact location.
- Acceptance Criteria:
  - Given a company-posted transcript, then it is stored, hosted = true, and segmented with an anchor per paragraph.
  - Given a third-party transcript, then only a deep-link out is stored (hosted = false); full text is not rehosted.
- Priority: P0
- Dependencies: I (ingestion); Integration (EDGAR/SEDAR+).
- Open Questions: `[NEEDS DECISION]` per-ticker list of which sources are company-posted (safe to host).

**G2. Annotation = citation + click-through**
- Description: an annotation links a segment/locator to a target (event / metric / guidance / sector read); it is both the number's citation and the deep-link the user clicks to verify.
- User Story: As the analyst, I want to click a displayed number and land on the exact paragraph that supports it so that I can verify from the primary source.
- Acceptance Criteria:
  - Given a headline number with an annotation, when clicked, the source opens scrolled to the anchored paragraph.
  - Given a hosted document, then the pinpoint highlight is shown; given a link-out, then the app opens the external URL (via the host's link dialog).
  - Given a pinpoint quote, then it is ≤15 words or a paraphrase.
- Priority: P0
- Dependencies: G1.
- Open Questions: none.

### H. Provenance & Staleness

**H1. Fact wrapper on every sourced number**
- Description: every sourced value carries value, unit, source document, locator, as-of, fetched-at, method, confidence.
- User Story: As the analyst, I want every number to carry where it came from and how fresh it is so that the dashboard is trustworthy and auditable.
- Acceptance Criteria:
  - Given any displayed sourced number, then hovering/expanding shows source, as-of, and method.
  - Given a value with no obtainable source, then it is stored null and flagged, never fabricated.
- Priority: P0
- Dependencies: none (foundational).
- Open Questions: none.

**H2. Computed staleness (RAG)**
- Description: staleness is computed from as-of vs the field's expected refresh window (prices: 1 trading day; guidance: until next event; consensus: own window).
- User Story: As a reader, I want a freshness indicator so that I know whether to trust a number at a glance.
- Acceptance Criteria:
  - Given a price with as-of older than one trading day, then it renders amber/red per threshold.
  - Given staleness is never persisted, then it is always recomputed at read time.
- Priority: P0
- Dependencies: H1.
- Open Questions: none.

**H3. `_ledger` export**
- Description: an append-only source log mirroring the research-repo `_ledger.md` discipline; each fetch/entry recorded.
- User Story: As the maintainer, I want a running source log so that the whole dataset is auditable outside the DB.
- Acceptance Criteria: given any ingest or manual entry, then a ledger line is appended with timestamp, field, source, method.
- Priority: P1
- Dependencies: I.
- Open Questions: none.

### I. Data Ingestion & Daily Refresh

**I1. Daily cron refresh**
- Description: a daily Vercel Cron job refreshes prices, calendar/estimates, matures reaction horizons, captures actuals + guidance moves on prints, and recomputes staleness.
- User Story: As the analyst, I want the dashboard current every trading day so that I never trigger refreshes manually.
- Acceptance Criteria:
  - Given a trading day, when cron runs, then prices for all 17 update and fetched-at advances.
  - Given a past event whose +3d horizon just elapsed, then that reaction point is populated.
  - Given an actual print detected, then miss/beat and guidance-move are computed and the transcript is queued for ingest.
- Priority: P0
- Dependencies: FMP integration; F1; C1; D1.
- Open Questions: `[NEEDS DECISION]` cron time-of-day and trading-calendar source (multiple exchanges/timezones across the 17).

**I2. Local historical backfill (yfinance)**
- Description: one-time, locally-run backfill of historical prices and past events; not part of the cron.
- User Story: As the maintainer, I want to seed history from my local machine so that reaction and charts have a baseline.
- Acceptance Criteria:
  - Given the backfill script runs locally, then N years of daily bars load for each ticker.
  - Given the same script were run from a Vercel function, then it is documented as unsupported (Yahoo blocks datacenter IPs).
- Priority: P0
- Dependencies: Data model (PriceBar).
- Open Questions: `[NEEDS DECISION]` backfill depth (years of prices, quarters of events).

**I3. Manual (Bloomberg) admin entry**
- Description: a structured entry surface for fields FMP can't cover; forces source + as-of + method on save.
- User Story: As the maintainer, I want to enter uncovered values with mandatory sourcing so that the ledger stays complete.
- Acceptance Criteria:
  - Given a manual value saved without source or as-of, then save is blocked.
  - Given a saved manual value, then its method is a manual one (`bloomberg_manual` / `filing_manual`) and it appears with a manual badge.
- Priority: P0
- Dependencies: H1.
- Open Questions: `[NEEDS DECISION]` Bloomberg data may not be redistributable to multiple viewers — legal review before exposing manual values in a shared app.

### J. Sector Aggregation & Reads

**J1. Thematic sector tagging**
- Description: many-to-many thematic tags (Copper, Gold/precious, Canadian energy, Software/VMS, EM/Brazil…).
- Priority: P1
- User Story: As the analyst, I want names grouped by theme so that I can view a sector at once.
- Acceptance Criteria: given a name tagged to two sectors, then it appears under both.
- Dependencies: E1.
- Open Questions: `[NEEDS DECISION]` final thematic taxonomy.

**J2. Sector "vibe + forward" read (LLM-synthesized)**
- Description: an LLM-generated summary of a sector's current tone and forward outlook, derived from member events, with provenance to those events.
- User Story: As the user, I want a plain-English sector read so that I can grasp a theme without reading every print.
- Acceptance Criteria:
  - Given member events since last read, then a new SectorRead is produced with as-of and the source event IDs.
  - Given the read, then each claim links back to a member event/annotation.
- Priority: P2
- Dependencies: J1; G2; LLM provider.
- Open Questions: `[NEEDS DECISION]` LLM provider/cost; guardrails against unsupported claims.

### K. Broad Index Headline Scan (Phase 2)

**K1. Shallow S&P 500 / EuroStoxx coverage**
- Description: `coverage = headline` names with only miss/beat, guidance move, reaction, and one management quote.
- Priority: P2
- User Story: As the analyst, I want a light scan of the broad market so that I can read sector tone beyond our own book.
- Acceptance Criteria: given a headline name, then only the shallow field set is fetched/shown (no production/full metric catalog).
- Dependencies: I1; FMP coverage/limits.
- Open Questions: `[NEEDS DECISION]` FMP free-tier request budget cannot cover 500+ names daily — needs a paid tier or scoping to reported-that-day names.

### L. Dashboard UI & Views

**L1. Watchlist overview**
- Description: all covered names with type badge, next event, last surprise, guidance move, latest reaction, freshness.
- User Story: As the analyst, I want one screen summarizing every name so that I can scan the book quickly.
- Acceptance Criteria: given the overview, then each row shows type-appropriate fields (developers show catalyst, not earnings) and a freshness indicator.
- Priority: P0
- Dependencies: most data features.
- Open Questions: none.

**L2. Security detail view**
- Description: per-name page with event history, metrics (est/actual/surprise), guidance timeline, reaction chart, and commentary with deep-links.
- User Story: As the analyst, I want a full per-name page so that I can review one company end-to-end and verify sources.
- Acceptance Criteria: given a security, then its full history renders with every headline number click-through-linkable.
- Priority: P0
- Dependencies: F1, G2, C1, D1.
- Open Questions: none.

### M. Auth & Access

**M1. Access control**
- Description: **N/A for personal use.** Public URL by design; no auth required. See Backend PRD §6.
- User Story: As the analyst, I want the app restricted to the firm so that internal research isn't public.
- Acceptance Criteria:
  - Given an unauthenticated request, then access is denied/redirected to login.
  - Given a read-only role, then admin/manual-entry routes are hidden and blocked server-side.
- Priority: P0
- Dependencies: hosting/auth provider.
- Open Questions: none — resolved as "no auth" for personal use.

---

## 5. User Flows

### Flow 1 — Onboarding a covered name (maintainer)
1. Maintainer opens Admin → Add Security.
2. Enters ticker; selects type (operating / developer / etf). **Decision point:** type determines the next fields.
3. If operating: assign headline metrics from the canonical dictionary; assign benchmark.
4. If developer: define expected catalyst types; assign benchmark; no earnings fields shown.
5. Save.
   - **Error/edge:** ticker not resolvable by FMP (e.g. `RIO.PA` / `SCMI.CN`) → app shows "no market data source found; add manual/local source or correct symbol" and saves the security in a "data-incomplete" state rather than failing silently.
6. Optional: run local backfill script to seed history.

### Flow 2 — Analyst reviews the latest print (primary happy path)
1. Analyst opens Watchlist overview.
2. Spots a name with a recent event badge and a surprise value.
3. Opens Security detail.
4. Reads miss/beat per headline metric and the guidance-move badge.
5. Clicks the guidance number. **Decision point:** hosted source vs link-out.
   - Hosted → source panel opens scrolled to the anchored paragraph, pinpoint highlighted.
   - Link-out → host link-confirmation dialog opens the external primary source.
6. Reviews the reaction chart (+1d/+3d/+1w, abs + excess).
   - **Error/edge:** +1w horizon shows "pending — populates 2026-08-03" because a week hasn't elapsed; analyst understands it isn't missing data.
7. Analyst is done in under two minutes, having verified from the primary source.

### Flow 3 — Daily refresh (system)
1. Vercel Cron fires at the configured time.
2. For each of the 17: refresh price; refresh calendar/estimates (operating).
3. For each past event: populate any reaction horizon that just matured.
4. Detect new actual prints → compute surprise, classify guidance move, queue transcript ingest.
5. Recompute staleness.
   - **Error/edge:** FMP returns a rate-limit or empty response for a ticker → that ticker's fields are left at prior values, fetched-at is NOT advanced, and staleness turns amber/red so the gap is visible rather than masked. Job continues for the rest.

### Flow 4 — Manual value entry (maintainer)
1. Maintainer opens a field FMP can't cover (e.g. small-cap consensus).
2. Enters value, unit, source, as-of.
   - **Error/edge:** save attempted without source or as-of → blocked with a validation message; nothing persists.
3. Value saved with a manual method (`bloomberg_manual` / `filing_manual`) and a manual badge; ledger line appended.

### Flow 5 — Event-windowed source snapshot (system)
Rationale: the reaction number says whether the move was anomalous; the sources say why. That "why" cannot be re-fetched a month later — Google News is recency-biased and the tweet layer already enforces a 180-day floor. So commentary must be captured at event time, not on demand.
1. On detecting a new event (Flow 3, step 4), the cron opens a source window for it: ~T−2 to T+35 calendar days (covers up to the +1m reaction).
2. Each daily run within that window polls the existing source engines (official press releases, Google/Bing/GDELT/HN news, FinTwit/X, independent research) scoped to the event's ticker + aliases, and appends new items to the event's `sources[]` snapshot — deduped by normalized headline/URL.
3. Items are classified (news vs opinion via the LLM enrichment) and quality-gated (spam/cashtag-stuffing, exclusion aliases, meaningful-mention) before append.
   - **Error/edge:** an engine is unreachable (e.g. Nitter direct from Vercel) → that engine is skipped for the day, its absence is flagged on the event, and the next day retries; the snapshot is never truncated to only the reachable engines silently.
4. When the +1m horizon matures, the event carries both the full reaction curve and the accumulated commentary in one record — nothing lost to recency decay.

---

## 6. Data Model & Architecture

Storage — two viable approaches; **v1 default is the git-snapshot pattern** the reference code already proves, with Postgres as the documented upgrade path:

- **v1 (recommended): git-snapshot.** Persist state as versioned JSON committed to the repo via the GitHub Contents API (the exact `shared-state.js` / `feedback.js` commit-pipe — see Appendix A). The daily cron writes `data/earnings.json` the same way the reference build writes `data/tweets.json`. This keeps the project at $0, gives a full audit trail in git history (one commit per refresh = the `_ledger` for free), and suits a daily (≈1 write/day) cadence. Reaction needs only ~5 price points per event (baseline, +1d, +3d, +1w, +1m), fetched on demand — not a full time-series store — so a database is not required at v1 scale.
- **Upgrade path: Neon Postgres** via Prisma, warranted only when the Phase-2 broad scan or a genuine growing daily time-series makes JSON snapshots unwieldy.

The frontend never fetches vendors directly; it reads the committed snapshot (or DB). Entities below are described conceptually and map cleanly onto either JSON documents or Postgres tables.

Key entities (field names / types abbreviated):

- **EntityRegistry** (single source of truth, ported from the reference `data/entity-registry.json` + `_entityRegistry.js` accessors). Existing per-ticker fields reused as-is: `ticker` (Bloomberg-style, e.g. `BN US`, `TGB CN`) · `legalName` · `displayName` · `aliases[]` · `exclusionAliases[]` · `sectorTags[]` · `cashtag` · `isCore`. **Earnings extension** adds: `securityType{operating|developer|etf}` · `headlineMetrics[]` (canonical keys) · `benchmark` (assigned reaction benchmark ticker) · `catalystTypes[]` (developers). `sectorTags` already provides the thematic taxonomy; `isCore` already distinguishes deep-coverage names from watchlist. `[NEEDS DECISION]` confirm none of the earnings-extension keys already exist in the live registry JSON before adding.

- **Security** `ticker PK · name · type{operating|developer|etf} · coverage{deep|headline} · listing · benchmark · currency` — 1:N to PriceBar, Event, Document, MetricDef; M:N to Sector.
- **PriceBar** `ticker FK · date · open/high/low/close/volume · source · fetchedAt` — unique(ticker, date).
- **MetricDef** `ticker FK · canonicalKey · isHeadline · isAdjusted? · displayLabel` — per-security metric declaration.
- **Event** `id PK · ticker FK · kind{earnings|catalyst} · period · scheduledDate · eventDate · timing · catalystType? · expectation{below|inline|above|unset} · guidanceMove?` — 1:N Metric, Guidance; 1:1 Reaction.
- **Metric** `id PK · eventId FK · canonicalKey · isHeadline · surprisePct` — 1:N Fact (roles: estimate/actual/prior/consensus).
- **Guidance** `id PK · eventId FK · canonicalKey · period · basis · version · supersededById` — 1:N Fact (roles: guidance_low/high).
- **Fact** (provenance wrapper) `id PK · role · valueNum/valueText · unit · asOf · fetchedAt · method{fmp|bloomberg_manual|filing_manual|llm_extracted} · confidence · sourceDocId? · locator · metricId?/guidanceId?`.
- **Reaction** `id PK · eventId FK (1:1)` — 1:N ReactionPoint.
- **ReactionPoint** `reactionId FK · horizon{d1|d3|w1|m1} · absReturn · excessReturn · benchmark · computedAt` — derived, not a Fact. (`m1` = +1 month, added in v0.2.)
- **EventSourceSnapshot** `id PK · eventId FK · capturedAt · windowStart · windowEnd · items[]` — the commentary captured during the event's source window (Flow 5). Each item: `{ url, headline, source, provenance, time, summary, articleType{news|opinion}, engine, engagement? }`. This is the "who's talking about it" layer bound to the event so it survives recency decay. Populated by reusing the existing news / press-release / tweet engines, scoped by the entity's aliases.
- **Document** `id PK · ticker FK · type · period · sourceUrl · hosted · ingestedAt` — 1:N Segment.
- **Segment** `id PK · documentId FK · speaker · speakerRole · section{prepared|qa} · paraIndex · anchorId · text`.
- **Annotation** `id PK · documentId FK · segmentId? · targetType · targetId · pinpoint · note · createdBy` — citation + deep-link.
- **Sector / SecuritySector / SectorRead** — thematic tags (M:N) and Phase-3 LLM reads (`asOf · vibe · forward · sourceEventIds · staleness`).

Architecture: Next.js on Vercel; API routes read the DB; a Vercel Cron endpoint (`/api/cron/daily`) runs ingestion; a local `/scripts` folder runs one-time backfill from a residential IP. Distinction that shapes the model: **sourced numbers are Facts** (full provenance); **derived numbers** (reaction returns) store formula inputs + computedAt instead.

`[NEEDS DECISION]` Annotation target is loosely polymorphic (targetType + targetId string), not FK-enforced; and Fact belongs to one parent via optional FKs rather than a hard check constraint. Both can be tightened for full referential integrity.

---

## 7. Technical Considerations

- **What runs from Vercel vs what does not (corrected in v0.2 against the reference code):**
  - *Works server-side from Vercel egress:* Yahoo Finance `query2.finance.yahoo.com` (the reference `ticker-lookup.js` calls it in production), SEC EDGAR, Google News / Bing / GDELT / Hacker News Algolia RSS+JSON, publisher IR RSS, Newsfile, the B3 Mziq JSON API, the GitHub Contents API, and the Anthropic API.
  - *Blocked from Vercel egress (datacenter IP):* Nitter (`nitter.net` TCP-rejects AWS/Vercel), DuckDuckGo, and Bluesky — confirmed by the reference `probe-tweets.js`. These are reached via a **Cloudflare Worker proxy** (`TWEET_WORKER_URL` + `TWEET_WORKER_SECRET`). The earlier "yfinance/Yahoo is blocked" note was too broad: the block is on the scraping-auth path and those three hosts, not on Yahoo finance data.
  - Implication: prices and (likely) earnings dates come from Yahoo `quoteSummary` modules server-side; **FMP is only a fallback** for consensus estimates Yahoo doesn't return cleanly, shrinking the FMP free-tier dependency.
- **Auth:** internal tool → must be gated (Section M). Read-only vs editor roles enforced server-side, not just in UI.
- **Secrets:** all keys (Anthropic, FMP-if-used, `GH_PAT`, `TWEET_WORKER_SECRET`, TwitterAPI.io) live only in server env vars; never shipped to the client.
- **Required request headers (reference-proven, easy to get wrong):** SEC EDGAR requires a `User-Agent` carrying a contact (`Earnings Tracker <email>`); Q4-hosted IR feeds (Century, Hudbay) and several vendor IR platforms `403` anything that isn't a real browser UA + `Accept-Language` — sending a current Chrome UA turns `403→200`. B3 Mziq requires POST + a known `Origin`/`Referer` despite a misleading `401` on naive GETs.
- **Privacy/compliance:** Bloomberg-sourced values may be subject to redistribution limits — exposing them in a shared app needs legal review. Investment-relevant data implies the app is decision-support, not advice; add a disclaimer.
- **Rate limits:** Yahoo/Google/Bing/GDELT are unauthenticated and rate-sensitive — cache aggressively (the reference uses `s-maxage` of 600s–86400s per endpoint) and cap concurrency (article verification runs a pool of 8). FMP free ≈ 250 req/day (fallback use only). TwitterAPI.io is metered per call.
- **Reliability & degradation:** vendor gaps must degrade visibly (staleness), never silently overwrite or blank good data. Fail-soft is the reference norm — a dead feed returns `[]` and the sibling sources still run.
- **HTML-parser fragility:** the ABXX (Next.js RSC chunks) and SHLE (Webflow blocks) press-release parsers break on any site redesign. They must fail soft (return `[]` → "no official sources" banner), and a monitoring check should flag a source that returns zero items for N consecutive days.
- **Persistence mechanics (git-commit-pipe):** writes go through the GitHub Contents API with optimistic concurrency — GET the file SHA, PUT with it, handle `409` (stale SHA → client refresh + retry) and `503` (no `GH_PAT` → graceful localStorage-only fallback). One commit per write; the next deploy serves the new file (~1 min end-to-end), so the client treats localStorage as the immediate source of truth and merges the server copy on mount.
- **Scalability:** schema is universe-agnostic; the constraint at 500+ names is the vendor request budget and cron runtime, not the model.
- **LLM provider abstraction:** enrichment (summary + news/opinion classification + pt-en translation) and any sector reads go through a thin provider interface. The reference uses Anthropic `claude-haiku-4-5-20251001` with strict-JSON prompts; keep that behind an interface so the model can be swapped, and log prompts/outputs for auditability. `[NEEDS DECISION]` default model and monthly cost ceiling.

---

## 8. UI/UX Specifications

- **Layout:** desktop-first (analyst workflow). Watchlist overview as a dense, scannable table; security detail as a single scrolling page (events → metrics → guidance timeline → reaction chart → commentary).
- **Type-aware rendering:** developers never show earnings/estimate fields; they show catalyst type + expected window. ETFs show price/distribution/holdings only.
- **Every number is sourced and fresh:** each headline value carries a small freshness dot and an expandable provenance popover; click-through opens the source at the exact paragraph.
- **Editorial standard:** plain English throughout, no jargon ("re-rate", "the drill bit"); short sentences; verdict-style phrasing over description.
- **Interaction model:** click a number → deep-link; hover → provenance; filters and sorting handled client-side.
- **Navigation:** global nav = Overview · (later) Sectors · Admin. Breadcrumb back from detail to overview.
- **Responsive:** functional read view on mobile (overview + detail); admin/entry is desktop-only.
- **Accessibility:** legible contrast in light/dark; no reliance on color alone for staleness (pair with label/icon).

---

## 9. Integration Details

This section lists each integration at the product level. Exact endpoints, headers, params, parsing, and gotchas — everything needed to port a connection into the new repo — are in **Appendix A**. Every integration is API-key or public (no OAuth), so there are no OAuth scopes to manage; the sensitive credentials are `GH_PAT`, the Anthropic key, `TWEET_WORKER_SECRET`, and (optional) FMP / TwitterAPI.io keys. No inbound webhooks — everything is poll-on-cron.

**Market data & related news — Yahoo Finance (primary), FMP (fallback)**
- Yahoo `query2` search resolves a Bloomberg `(symbol, exchange)` pair to the real company name + Yahoo symbol (needed to fix name-collision searches), and `quoteSummary` supplies prices, earnings dates, and calendar events. Works server-side from Vercel. Data extracted: daily/last price for reaction, next earnings date, and estimates where present.
- **Yahoo related news** comes from the *same* `query2` search call — its `news` array is currently suppressed with `newsCount=0`; raising that returns per-ticker related news with no extra request. Yahoo also exposes a per-symbol news feed. It folds into the news fan-out (below / Appendix A.7) as one more engine, deduped against Google/Bing/GDELT so it adds coverage without a new dependency or cost.
- FMP is the fallback for consensus estimates Yahoo doesn't return cleanly. API key, ~250 req/day free. `[NEEDS DECISION]` confirm which fields come from Yahoo vs FMP after a coverage test on the 17.
- **Small-cap consensus:** where Yahoo (and the FMP fallback) return no estimate — likely `SCMI`/`DBG`/`WRN` and possibly `SHLE/TNZ/VLE` — the field is stored `null` with a staleness flag and miss/beat shows `n/a — no estimate`. No paid manual-consensus vendor is used.

**Official press releases & filings — per-holding registry + shared fetcher**
- Ported from `_officialSources.js` (per-ticker feed registry) + `_feedFetcher.js` (fetch/parse/dedup). Source kinds: `edgar` (SEC Atom, filtered to material forms), `rss` (IR-page / Newsfile wire), `mziq` (B3 JSON API), `html-abxx` / `html-shle` (IR pages with no feed). Data extracted: release/filing headline, URL, timestamp, provenance chip (`regulatory` / `ir-page` / `wire`). This is the earnings-document layer — reused verbatim for the new repo. Full per-ticker map and parsers in Appendix A.

**News fan-out — multi-engine**
- Ported from `news.js` + `_searchEngines.js`: Google News RSS (3 date buckets: bare, `when:1y`, `when:5y`), **Yahoo ticker news** (from the `query2` search `news` array), Bing News, GDELT 2.0 DOC, Hacker News Algolia, SEC EDGAR full-text, and think-tank RSS. Deduped by URL then by normalized headline. Feeds the EventSourceSnapshot "who's talking about it" layer. Data extracted: headline, publisher URL, source, time.

**Article verification — Google News redirect resolver**
- Ported from `_articleVerifier.js`: resolves opaque `news.google.com/rss/articles/...` redirects to the publisher URL and verifies it's a real article via URL-pattern allowlist + `og:type` / JSON-LD (Range-request the first ~30 KB). Needed because the `site:<host>` path returns redirect URLs indistinguishable by shape. Cached 24h, concurrency 8.

**Feed discovery — analyst-pasted URLs**
- Ported from `discover-feed.js`: given any pasted URL, returns an RSS feed (autodiscovery → path conventions) or a Google-News `site:<host>` filter fallback; major-news hosts (WSJ/FT/Bloomberg/etc.) are routed straight to site-filter. Also classifies Substack profile and X-account URLs. Lets the analyst add a custom source without knowing its feed.

**Social / FinTwit — X via Cloudflare Worker + TwitterAPI.io**
- Company-owned posts via Nitter profile RSS, proxied through a Cloudflare Worker (Nitter is blocked from Vercel egress). Curated FinTwit commentary via TwitterAPI.io `advanced_search` + `last_tweets`, filtered by the FinTwit roster + topic/cashtag/hashtag expansion. All tweets pass the quality + spam gates (Appendix B). Data extracted: tweet text, handle, engagement, time. `[NEEDS DECISION]` TwitterAPI.io key ownership + monthly cost.

**LLM enrichment — Anthropic API**
- `claude-haiku-4-5-20251001`, `x-api-key` + `anthropic-version: 2023-06-01`, strict-JSON prompts. Two jobs proven in the reference: (1) news 1–2 sentence summary + `news`/`opinion` classification (the opinion/analysis items are exactly the "explain or talk about it" commentary); (2) press-release summary + `pt-en` translation for B3 Portuguese filings. Extend for guidance extraction and guidance-move classification. Behind a provider interface.

**Persistence — GitHub Contents API commit-pipe**
- Ported from `shared-state.js` / `feedback.js`: GET reads the deploy-baked JSON; PUT commits via the Contents API with a fine-grained PAT (`Contents: Read & Write` on the repo only), optimistic-concurrency via file SHA, `409` retry, `503` graceful fallback. Stores watchlist, custom sources, themes, feedback, and (new) `data/earnings.json`.

**Scheduler — Vercel Cron**
- Triggers the daily refresh endpoint; schedule in `vercel.json`. Runs price/calendar refresh, reaction-horizon maturation, actual-print capture, and event-source-window polling (Flow 5). `[NEEDS DECISION]` cron time-of-day + multi-venue trading calendar; Hobby-tier cron limits.

**SEDAR+ (Canadian filings) — gap**
- No clean API; the reference covers Canadian names via Newsfile + IR-page RSS instead of SEDAR+ directly. `[NEEDS DECISION]` whether direct SEDAR+ retrieval is needed beyond what Newsfile/IR already give.

**Bloomberg — manual, no integration**
- No API/feed. Values analyst-entered via admin with mandatory sourcing. Redistribution constraints apply (see Section 11).

**yfinance — local backfill only**
- Historical daily bars for one-time seeding, run locally (residential IP). Not called from Vercel (Yahoo `query2` REST endpoints are used there instead).

---

## 10. Monetization & Plan Tiers

*[DRAFT — internal tool; no external monetization planned.]*

This is a personal dashboard, so there is no customer-facing pricing. The relevant model is **operating cost**, kept at/near zero:

| Component | Tier | Cost basis |
|---|---|---|
| FMP | Free | ~250 req/day; sufficient for 17 names, not for the Phase-2 index scan |
| Neon Postgres | Free | within free storage/compute for this data volume |
| Vercel | Hobby/Pro | Cron + hosting; `[NEEDS DECISION]` Hobby cron limits may require Pro |
| Anthropic API | Usage-based | only when Phase-2/3 LLM features are enabled |

`[NEEDS DECISION]` If the Phase-2 broad scan is pursued, a paid FMP tier is likely required — budget owner and ceiling to be set. If the tool were ever externalized, tiers would be drafted then (out of scope now).

---

## 11. Open Questions & Risks

Collected `[NEEDS DECISION]` items:
- KPI selection and analyst-prep-time baseline (§2).
- Canonical ticker/symbol resolution table across venues (§A1).
- Developer catalyst date source-of-truth and cadence (§B1).
- Beat/miss denominator when consensus and single-estimate both exist (§C1).
- Canonical metric dictionary contents + unit conventions (§E1).
- Reaction baseline anchor for BMO vs AMC timing (§F1).
- Per-ticker list of company-posted (hostable) sources (§G1).
- Cron time-of-day + multi-venue trading calendar (§I1).
- Historical backfill depth (§I2).
- Bloomberg redistribution legality in a shared app (§I3).
- Final thematic sector taxonomy (§J1).
- LLM provider/model, cost ceiling, and anti-hallucination guardrails (§J2, §7).
- FMP free-tier request budget vs the 500+ name Phase-2 scan (§K1).
- Auth provider / SSO vs access list (§M1).
- Annotation target and Fact-parent referential integrity (§6).
- Storage choice: git-snapshot for v1 vs Postgres (§6) — recommended git-snapshot, confirm.
- Which fields come from Yahoo `quoteSummary` vs FMP fallback, decided by a coverage test on the 17 (§9).
- Whether any earnings-extension key already exists in the live `entity-registry.json` (§6).
- TwitterAPI.io key ownership + monthly cost; Cloudflare Worker ownership for the Nitter proxy (§9).
- Direct SEDAR+ retrieval need beyond Newsfile/IR (§9).
- Vercel cron tier limits + multi-venue trading calendar (§9/§10).

Risks:
- **Small-cap coverage gap:** Yahoo (and the FMP fallback) will not reliably supply consensus estimates/calendar for `SCMI`, `DBG`, `WRN`, and possibly `SHLE/TNZ/VLE`. Rather than a paid manual-consensus vendor, these fields stay `null` + staleness-flagged and miss/beat shows `n/a — no estimate`; actuals, reaction, and sources still populate. *Mitigation: run a coverage test on the 17 before building ingestion so the gap is known, not discovered live.*
- **Commentary recency-decay:** the "why" behind a reaction cannot be re-fetched a month later (Google News recency bias; 180-day tweet floor). *Mitigation: EventSourceSnapshot captured at event time within the source window (Flow 5) — this is a correctness requirement, not a nice-to-have.*
- **Proxy/scraper fragility:** the Cloudflare Worker + Nitter path for X is inherently brittle (Nitter instances and X read-paths break periodically); treat the tweet layer as best-effort, never a hard dependency for an event's completeness.
- **HTML-parser fragility:** the ABXX/SHLE IR-page parsers break on site redesigns — fail soft + monitor for zero-item sources.
- **Unauthenticated-endpoint stability:** Yahoo `query2`, Google News RSS, GDELT, Bing are undocumented/unofficial and can change shape or rate-limit without notice — cache hard, degrade visibly.
- **Vendor reliability generally:** design must degrade visibly (staleness), never silently overwrite or blank good data.
- **Copyright:** hosting third-party transcripts/articles is not permitted — only link-out (the reference resolves and links to publisher URLs, it does not rehost); enforce in ingest.
- **Compliance:** Bloomberg redistribution; and the tool is decision-support, not advice.
- **Bus factor:** single maintainer for the manual layer; if unmaintained, manual fields silently go stale (mitigated by staleness flags surfacing it).
- **LLM error:** extracted guidance or generated summaries could misstate a number — every LLM output must be annotation-backed and verifiable.

---

## 12. Future Roadmap

**Near-term (finish v1 / P0–P1)**
- FMP coverage test across the 17; ingestion + daily cron; multi-horizon reaction; document ingest + deep-link annotations; watchlist + detail views; auth; local backfill; manual admin entry; `_ledger` export; thematic tagging.

**Mid-term (P1–P2)**
- Phase-2 broad S&P 500 / EuroStoxx headline scan (scoped to reporting-day names or a paid FMP tier).
- Phase-3 sector "vibe + forward" reads.
- Event alerts/notifications (upcoming reports, surprise beyond a threshold, guidance cut).
- Pre-earnings preview generation (LLM, annotation-backed).

**Long-term**
- Broader universe and configurable watchlists per PM.
- Integration with the existing tearsheet product (thesis-vs-print linking).
- Mobile-first read view.
- Portfolio-level roll-ups (weighted exposure to reporting names, aggregate surprise).

---

## Appendix A — Reusable Connection Cookbook

Port-ready specifics for each proven connection. All are server-side, poll-on-cron, no OAuth. Cache with `Cache-Control: s-maxage` where noted. Every fetch fails soft (return `[]`, keep siblings alive).

### A.1 Yahoo Finance — symbol resolution + market data + related news
- Search: `GET https://query2.finance.yahoo.com/v1/finance/search?q=<symbol>&quotesCount=10&newsCount=10`. Raising `newsCount` returns a `news` array `[{title, link, publisher, providerPublishTime}]` in the *same* call → per-ticker related news for the fan-out (A.7); a per-symbol news feed is also available. Cache ~15 min.
- Prices / earnings / calendar: `https://query2.finance.yahoo.com/v6/finance/quoteSummary/<symbol>?modules=summaryDetail,price,earnings,calendarEvents` (module list to confirm in coverage test).
- Headers: browser UA + `Accept: application/json` + `Accept-Language: en-US,en;q=0.9`.
- Exchange mapping: Bloomberg suffix → Yahoo exchange codes, e.g. `US → [NMS,NYQ,ASE,NGM,NCM,PCX,NYS,...]`, `CN → [TOR,VAN,CVE,NEO,CDNX,...]`, `FP → [PAR]`, `BZ → [SAO]`, `IM → [MIL]`. Indices are prefixed `^` (`^GSPC`); try raw symbol then `^symbol`.
- Filter results to `quoteType=EQUITY` on an acceptable exchange (fall back to any-exchange same-symbol); store `longname` so news search uses the real name, not the ticker (fixes the "AAPL → bitcoin news" collision). Cache 24h.

### A.2 SEC EDGAR — filings
- Per-company Atom: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<cik>&type=&dateb=&owner=include&count=40&output=atom`.
- Full-text search available as a news engine.
- **Required** `User-Agent` with contact, e.g. `Earnings Tracker <email>` — SEC blocks generic UAs.
- Keep only material forms: `8-K, 10-K, 10-Q, 6-K, 20-F, 40-F, DEF 14A, PRE 14A, 425, S-1/F-1, S-3/F-3` (+ `/A` amendments). Label each with a human-readable form name.
- Per-holding CIKs (reference): `BN 0001001085 · CENX 0000949157 · HBM 0001322422 · WRN 0001364125 · TGB 0000878518`.

### A.3 Newsfile (wire RSS)
- `https://feeds.newsfilecorp.com/company/<id>`. Company IDs (reference): `WRN 1376 · TNZ 11001 · DBG 8003 · SCMI 11605`.
- Standard RSS 2.0; drop non-English cross-posts (`xml:lang` filter).

### A.4 IR-page RSS (Q4 platform + custom)
- Century `https://centuryaluminum.com/RSS/PressRelease.aspx`; Hudbay `https://hudbayminerals.com/rss/PressRelease.aspx`; Capstone `https://capstonecopper.com/feed/`; Valeura `https://www.valeuraenergy.com/feed/`.
- These `403` non-browser clients → send a current Chrome UA + `Accept-Language`. Topicus RSS `https://www.topicus.com/rss` publishes 404-ing links → rewrite to insert `/news/` (`urlFix`).

### A.5 B3 (BOLSY) — Mziq JSON API
- `POST https://apicatalog.mziq.com/filemanager/company/<fmId>/filter/categories/meta` (reference `fmId 5fd7b7d8-54a1-472d-8426-eb896ad8a3c4`).
- Headers: `Content-Type: application/json`, `Origin: https://ri.b3.com.br`, `Referer: https://ri.b3.com.br/en/regulatory-filings/`, browser UA. (Naive GET returns a misleading `401`; POST + Origin works.)
- Body: `{ categoryInternalNames: [...], language: "en_US", published: true }`. Categories: material facts, notice to shareholders, CVM 358, shareholder meetings. Falls back to PT if EN empty → flag for `pt-en` LLM translation.
- Response: `data.document_metas[]` → `{ file_title, permalink|file_url, file_published_date }`.

### A.6 IR pages with no feed — HTML parsers (fragile, fail soft)
- ABXX: `https://investors.abaxx.tech/press-releases` is a Next.js app; concatenate `self.__next_f.push([n,"..."])` RSC chunks, JSON-unescape, extract the `"pressReleases":[...]` array (`{title, slug, publish_date, excerpt}`), build URL `.../press-releases/<slug>`.
- SHLE: Webflow page; regex the repeating block (`news-release__date-field` → `/news-releases/<slug>` link → `<h5>` title → `news-release__excerpt`).

### A.7 News engines
- Google News RSS: `https://news.google.com/rss/search?q=<q>&hl=en-US&gl=US&ceid=US:en`; run 3 date buckets by appending `when:1y` / `when:5y` to `q` (bare query is recency-biased). UA `EarningsDashboard/1.0`. Item `<link>` on `site:` queries is an opaque redirect — resolve via A.8.
- Yahoo ticker news (from A.1's `query2` search `news` array), Bing News, GDELT 2.0 DOC, Hacker News Algolia (`https://hn.algolia.com/api/v1/search?query=<q>&tags=story`), think-tank RSS — run in parallel, dedup by URL then normalized headline (drop trailing "— Publisher", strip punctuation/stopwords, sort words).
- Cache `s-maxage=600, stale-while-revalidate=3600`.

### A.8 Google News redirect resolution + article verification
- Range-request first ~30 KB of the resolved page; accept if URL matches a per-host article pattern OR `og:type ∈ {article, news.article}` OR JSON-LD `@type ∈ {NewsArticle, Article, ...}`; reject on `og:type ∈ {website, profile, product, ...}`. Cache 24h, concurrency ≤ 8, 6 s per-fetch timeout. Substitute the resolved publisher URL so click-through is direct.

### A.9 X / FinTwit
- Company posts: Nitter profile RSS `https://nitter.net/<handle>/rss` — **blocked from Vercel**, proxy via Cloudflare Worker (`<TWEET_WORKER_URL>/?nitter=<handle>`, `X-Auth: <TWEET_WORKER_SECRET>`). Reference handles: `BN Brookfield · BOLSY B3_Oficial · ABXX abaxx_tech · TGB TasekoMines · TNZ TenazEnergy · VLE ValeuraEnergy · CS CapstoneCopper`.
- Curated commentary: TwitterAPI.io `advanced_search` + `last_tweets` over the FinTwit roster; expand queries with topic cashtags (`$COPX`, `$GDXJ`, ...) and hashtags. All tweets pass Appendix B gates.
- Diagnostic: a `probe` endpoint tests reachability of Nitter/StockTwits/Reddit/Yahoo/GNews/HN from the current egress before wiring a source in.

### A.10 Anthropic API — enrichment
- `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. Model `claude-haiku-4-5-20251001`, `max_tokens` ≈ 3000–4000.
- Prompt returns strict JSON (strip ``` fences before parse; fall back to un-enriched on any parse/HTTP error). Enrich only the top ~20–30 items per call to bound latency/cost.

### A.11 Persistence — GitHub Contents API
- `GET/PUT https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<branch>`; headers `Authorization: Bearer <GH_PAT>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, UA.
- PUT body: base64 content + `message` + `branch` + prior `sha` (from GET). Handle `404` (create), `409` (stale SHA → retry), `503` (no PAT → localStorage-only). Files: `data/shared-state.json`, `data/feedback-log.json`, `data/tweets.json`, and new `data/earnings.json`. PAT scope: fine-grained, `Contents: Read & Write` on the one repo.

### A.12 HTML/RSS parsing helpers (port `_html.js`)
- `decodeHtmlEntities` (hex → decimal → named, in that order — named last so `&amp;#39;` decodes correctly), `stripCdata`, `stripHtml`, `extractTag`. Route every RSS/HTML text field through these to avoid literal `&#8217;` leaking to the UI.

---

## Appendix B — Source Quality & Entity-Matching Utilities

Port these gates so the new repo's EventSourceSnapshot inherits the reference's precision. All operate on the entity registry (Appendix A / §6).

### B.1 Entity matching (`mentionsHolding`)
- Aliases from the registry (`legalName`, `displayName`, `ticker`, `aliases[]`); min length 3 (2-char aliases match everything).
- Short alphabetic aliases (≤5 chars, e.g. `BAM`) → word-boundary regex (matches "BAM closed at $51", not "Bambi"). Longer aliases → plain substring.
- Cashtag `$<BASE>` with word boundary. Canadian suffix forms `<BASE>.<TO|V|NE|VN|CN>` (optional `$`). Bare ticker without `$` is NOT matched (too ambiguous).
- Curation traps baked into the registry: `B3` alone matches "Boeing 737" → use `B3 SA` / `Bolsa Brasil`; `Hat` alone substrings "what/that" → use `Hat copper-gold`. `exclusionAliases[]` drop known collisions (`Hoya Capital`, boxer "De La Hoya", etc.).

### B.2 Tweet quality + spam gates (`tweetQuality`)
- Drop: text < 50 chars after stripping URLs/mentions/emoji; zero engagement AND > 2 h old (fresh tweets skip the floor); the holding's own IR handle.
- Hard time floor: 180 days (tweets decay faster than news).
- Cashtag-stuffing detector: ≥3 distinct cashtags with ≤12 prose words (or cashtags ≥5 and ≥30% of words) → spam list. `isMeaningfulMention` further rejects a tweet where the entity appears ONLY as a bare cashtag inside a stuffed list.
- Spam-template patterns: `t.me/`, `telegram:`, "jake signals", "free signals", pump/moon/10x, "not financial advice".
- Ranking: `score = log10(likes + 2·retweets + 1) · recencyWeight`, weights `1.0 (<2h) / 0.85 (<24h) / 0.6 (<7d) / 0.3 (<30d) / 0.1 (older)`.

### B.3 Keyword matching for independent research (`_independentSources`)
- Two-pass: literal substring, then multi-word fallback requiring all words (≥3 chars) within a 400-char window — catches paraphrase ("Brazil's central bank raised rates" for "Brazil interest rates") that a strict phrase match misses.

### B.4 Topic → account/cashtag expansion (`_finTwitAccounts`)
- Per-entity `sectorTags` intersect the FinTwit roster's topics to pick accounts to poll; theme queries derive topics from type + keyword hints. Topic → cashtag/hashtag maps expand searches (copper → `$JJC $CPER $COPX` / `#copper`).

---

## Appendix C — Build Guide for Claude Code

This appendix is written to be executed by a coding agent in the terminal. It maps every connection from Appendices A–B onto concrete files, gives each a function contract, and orders the work so each step is testable before the next. Vendor specifics (URLs, headers, quirks) are NOT repeated here — each contract points back to the Appendix A/B section that defines them.

### C.0 How the agent should use this document
1. Put a `CLAUDE.md` at the repo root (starter in C.3). It points here and states the rules.
2. Work the task list (C.8) top to bottom — each task has an acceptance check; do not start a task until its dependencies pass.
3. For any ported module, reproduce the connection exactly as Appendix A/B specifies. Never invent an endpoint, header, or field name — if a spec is missing, stop and flag it, don't guess.
4. Every sourced number is stored as a Fact (C.6). Derived numbers (reaction) store inputs + `computedAt`. Nulls over guesses.
5. All vendor calls are server-side; secrets come from env (C.4).

### C.1 Repo scaffold
```
/
├─ CLAUDE.md                  # router → this PRD + conventions (C.3)
├─ vercel.json                # cron + function config (C.7)
├─ package.json
├─ data/
│  ├─ entity-registry.json    # single source of truth (ported + extended, C.5)
│  ├─ earnings.json           # event snapshots, git-committed by cron (C.6)
│  ├─ shared-state.json       # watchlist / custom sources / themes
│  └─ feedback-log.json
├─ src/                       # cross-runtime (client + api)
│  ├─ entityRegistry.js       # client mirror of registry accessors
│  └─ itemTagger.js           # item → entity/topic/tier tagging
├─ api/
│  ├─ _entityRegistry.js      # server registry loader (reads data/*.json)
│  ├─ _officialSources.js     # per-ticker feed registry            [A.2-A.6]
│  ├─ _feedFetcher.js         # fetch/parse/dedup official sources   [A.2-A.6, A.12]
│  ├─ _html.js                # decode/strip helpers                 [A.12]
│  ├─ _searchEngines.js       # bing/gdelt/hn/edgar/thinktank        [A.7]
│  ├─ _articleVerifier.js     # google-news redirect + verify        [A.8]
│  ├─ _tickerMatch.js         # mentionsHolding etc.                 [B.1]
│  ├─ _tweetQuality.js        # quality/spam gates                   [B.2]
│  ├─ _finTwitAccounts.js     # roster + topic/cashtag expansion     [B.4]
│  ├─ _yahoo.js               # NEW: query2 search + market data     [A.1]
│  ├─ _reaction.js            # NEW: multi-horizon abs/excess        [F1, §6]
│  ├─ _earningsStore.js       # NEW: read/write earnings.json via GH [A.11]
│  ├─ news.js                 # endpoint (multi-engine + enrich)     [A.7,A.10]
│  ├─ press-releases.js       # endpoint (official + enrich)         [A.2-A.6,A.10]
│  ├─ tweets.js               # endpoint (worker + twitterapi.io)    [A.9,B.2]
│  ├─ discover-feed.js        # endpoint (feed autodiscovery)
│  ├─ shared-state.js         # endpoint (GH persistence)            [A.11]
│  ├─ feedback.js             # endpoint (GH persistence)            [A.11]
│  ├─ ticker-lookup.js        # endpoint (yahoo search)              [A.1]
│  ├─ earnings.js             # NEW endpoint: events+reaction+sources
│  └─ cron/daily.js           # NEW: daily refresh (Vercel Cron)
├─ scripts/
│  └─ backfill.mjs            # local one-time yfinance seed (residential IP)
└─ app/                       # frontend (overview, detail, admin)
```

### C.2 Ported vs new
- **Ported verbatim** (behaviour fixed by Appendix A/B; recreate contract exactly): `_html`, `_entityRegistry`, `_officialSources`, `_feedFetcher`, `_searchEngines`, `_articleVerifier`, `_tickerMatch`, `_tweetQuality`, `_finTwitAccounts`, and the endpoints `news`, `press-releases`, `tweets`, `discover-feed`, `shared-state`, `feedback`, `ticker-lookup`.
- **New for this project:** `_yahoo`, `_reaction`, `_earningsStore`, `api/earnings`, `api/cron/daily`, the `entity-registry.json` earnings extension, and the frontend.

### C.3 Root `CLAUDE.md` starter (paste as-is)
```md
# Earnings & Catalyst Dashboard — build router

Spec: docs/PRD_Earnings_Catalyst_Dashboard.md. Read it before coding.
Build order + acceptance checks: PRD Appendix C.8. Connection specs: A & B.

Rules:
- New git repo, but reuse the reference connections EXACTLY (PRD Appendix A/B).
  Never invent an endpoint/header/field. Missing spec -> stop and ask.
- Server-side vendor calls only; secrets from env (Appendix C.4).
- Storage v1 = git-snapshot via GitHub Contents API (Appendix A.11), not a DB.
- Every sourced number is a Fact {value,unit,source,asOf,fetchedAt,method}.
  Derived numbers store inputs + computedAt. Null + staleness over guesses.
- Type-first: operating->earnings flow, developer->catalyst flow, etf->price only.
- Fail soft: a dead source returns [] and siblings keep running.
- Plain-English UI copy. No jargon.
```

### C.4 Env-var manifest
| Var | Used by | Purpose | Required |
|---|---|---|---|
| `GH_PAT` | `_earningsStore`, `shared-state`, `feedback` | Contents API commit-pipe (fine-grained, Contents R/W on this repo) | Yes for writes; 503 fallback if absent |
| `ANTHROPIC_API_KEY` | `news`, `press-releases`, enrichment | Haiku summary/classify/translate | Yes for enrichment |
| `TWEET_WORKER_URL` / `TWEET_WORKER_SECRET` | `tweets` | Cloudflare Worker proxy for Nitter (blocked from Vercel) | Yes for company X posts |
| `TWITTERAPI_IO_KEY` | `tweets` | FinTwit `advanced_search` / `last_tweets` | Optional |
| `FMP_API_KEY` | `_yahoo` fallback | consensus estimates Yahoo lacks | Optional |

### C.5 Entity-registry contract (`_entityRegistry.js`)
Existing exports to reproduce: `getAllEntities()`, `getCoreEntities()`, `getEntity(ticker)`, `getAliases(ticker)`, `getExclusionAliases(ticker)`, `getSectorTags(ticker)`, `getCashtag(ticker)`.
Add one: `getEarningsConfig(ticker) -> { securityType, headlineMetrics: string[], benchmark: string, catalystTypes: string[] } | null`.
Registry entity JSON (existing + extension):
```json
{
  "ticker": "CS CN",
  "legalName": "Capstone Copper Corp.",
  "displayName": "Capstone Copper",
  "aliases": ["Capstone Copper", "Capstone", "Mantoverde", "Santo Domingo"],
  "exclusionAliases": [],
  "sectorTags": ["copper", "mining", "commodities"],
  "cashtag": "CS",
  "isCore": true,
  "securityType": "operating",
  "headlineMetrics": ["production_cu_kt", "c1_usd_lb", "ebitda_usd_m"],
  "benchmark": "HG=F",
  "catalystTypes": []
}
```

### C.6 `data/earnings.json` shape (v1 git-snapshot)
```json
{
  "schema": "earnings/v1",
  "lastUpdated": "2026-07-24T06:00:00Z",
  "events": [
    {
      "id": "CS_CN_2026Q1",
      "ticker": "CS CN",
      "kind": "earnings",
      "period": "FY2026 Q1",
      "scheduledDate": "2026-05-06",
      "eventDate": "2026-05-06",
      "timing": "AMC",
      "metrics": [
        {
          "key": "production_cu_kt", "isHeadline": true, "surprisePct": 3.1,
          "estimate": { "value": 52.0, "unit": "kt", "source": {"url":"...","label":"consensus","provenance":"wire","locator":null}, "asOf":"2026-05-05", "fetchedAt":"2026-05-06T21:10:00Z", "method":"fmp", "confidence":0.8 },
          "actual":   { "value": 53.6, "unit": "kt", "source": {"url":"...","label":"IR press release","provenance":"ir-page","locator":"para-4"}, "asOf":"2026-05-06", "fetchedAt":"2026-05-06T21:10:00Z", "method":"filing_manual", "confidence":1.0 }
        }
      ],
      "guidance": [
        { "key":"production_cu_kt", "period":"FY2026", "low":{}, "high":{}, "version":1, "move":"held", "source":{} }
      ],
      "reaction": {
        "benchmark": "HG=F",
        "points": [
          { "horizon":"d1", "absReturn":-0.021, "excessReturn":-0.014, "benchmark":"HG=F", "computedAt":"2026-05-07T21:00:00Z" },
          { "horizon":"d3", "absReturn":null, "excessReturn":null, "benchmark":"HG=F", "computedAt":null },
          { "horizon":"w1", "absReturn":null, "excessReturn":null, "benchmark":"HG=F", "computedAt":null },
          { "horizon":"m1", "absReturn":null, "excessReturn":null, "benchmark":"HG=F", "computedAt":null }
        ]
      },
      "sources": {
        "windowStart": "2026-05-04", "windowEnd": "2026-06-10", "capturedAt": "2026-05-07T06:00:00Z",
        "items": [
          { "url":"...", "headline":"...", "source":"Reuters", "provenance":"news", "time":"2026-05-06T22:00:00Z", "summary":"...", "articleType":"news", "engine":"google" }
        ]
      }
    }
  ]
}
```
`Fact` = `{value, unit, source:{url,label,provenance,locator}, asOf, fetchedAt, method, confidence}`. `method` is one of `yahoo | fmp | bloomberg_manual | filing_manual | llm_extracted`.

### C.7 New-module contracts
`_yahoo.js` (specs -> A.1):
- `resolveSymbol(bloombergTicker) -> { yahooSymbol, name, exchange } | null`
- `fetchQuote(yahooSymbol) -> { close, currency, asOf } | null`
- `fetchDailyCloses(yahooSymbol, fromISO, toISO) -> [{ date, close }]`
- `fetchEarningsMeta(yahooSymbol) -> { nextDate|null, estEps|null, estRevenue|null }`
- `fetchTickerNews(yahooSymbol) -> [{ url, headline, source, time }]` (from the search `news` array; feeds the news fan-out)

`_reaction.js` (specs -> F1, §6):
- `baselineDate(eventDate, timing) -> ISODate` (BMO -> event day; AMC -> next session)
- `maturedHorizons(eventDate, timing, todayISO) -> ('d1'|'d3'|'w1'|'m1')[]`
- `computeReaction(baselineClose, closesByDate, benchCloses, horizons) -> [{ horizon, absReturn, excessReturn, benchmark, computedAt }]`

`_earningsStore.js` (persistence -> A.11):
- `readEarnings() -> { schema, events }` (deploy-baked JSON; `{events:[]}` on miss)
- `writeEarnings(next) -> { ok }` (GH Contents PUT with SHA; 409 retry; 503 if no PAT)
- `upsertEvent(store, event)`, `appendEventSources(store, eventId, items)`, `setReactionPoint(store, eventId, point)`

`api/earnings.js`:
- `GET /api/earnings?ticker=BN+US` -> `{ ticker, events:[...], fetchedAt }` (read-only from store; never calls vendors)

`api/cron/daily.js` orchestration (idempotent; safe to re-run):
1. For each core ticker: `resolveSymbol` -> `fetchQuote` -> append to price cache.
2. `fetchEarningsMeta` (operating) / registry catalyst dates (developer) -> upsert `scheduledDate`.
3. Detect a new actual print -> create/complete Event, capture actuals as Facts, compute `surprisePct`, classify `guidanceMove`.
4. For each open Event: `maturedHorizons` -> `computeReaction` for newly-matured horizons -> `setReactionPoint`.
5. For each Event inside its source window: poll `press-releases` + `news` + `tweets` scoped by `getAliases`/`tickerSearchTokens`, gate via B.1/B.2, enrich (A.10), `appendEventSources` (dedup).
6. `writeEarnings` (one commit). Recompute staleness at read time.

### C.8 Build task list (ordered; each has an acceptance check)
- **T1 — Scaffold + foundation.** Create tree (C.1), port `_html` (A.12), `_entityRegistry` + extended `entity-registry.json` (C.5). *AC:* `getEarningsConfig` returns a config for all core tickers; `decodeHtmlEntities('&#8217;')` yields the right-single-quote char.
- **T2 — Official sources.** Port `_officialSources` + `_feedFetcher` + `api/press-releases` (A.2-A.6, A.12). *AC:* `GET /api/press-releases?ticker=BN+US` returns ≥1 EDGAR item; a Q4 IR feed (CENX) returns 200 with the browser UA.
- **T3 — News + verification.** Port `_searchEngines`, `_articleVerifier`, `api/news` (A.7-A.8, A.10). *AC:* `/api/news?q=Capstone+Copper` returns deduped items; a `site:` redirect resolves to a publisher URL.
- **T4 — Matching + social.** Port `_tickerMatch`, `_tweetQuality`, `_finTwitAccounts`, `api/tweets` (A.9, B.1-B.4). *AC:* `mentionsHolding('$BN closed up', 'BN US')` is true and `mentionsHolding('Bambi', 'BN US')` is false; a cashtag-stuffed string is dropped.
- **T5 — Market data.** Build `_yahoo` + port `api/ticker-lookup` (A.1). *AC:* `resolveSymbol` + `fetchDailyCloses` succeed for all 17, including `RIO.PA`, `SCMI.CN`, `GDXJ`.
- **T6 — Reaction.** Build `_reaction` (F1). *AC:* `computeReaction` returns 4 horizons with correct baseline for BMO vs AMC; not-yet-elapsed horizons return `computedAt:null`.
- **T7 — Store + endpoint.** Build `_earningsStore` (A.11) + `api/earnings`. *AC:* a manual `writeEarnings` commits `data/earnings.json`; `GET /api/earnings` reads it back; missing `GH_PAT` -> 503 not crash.
- **T8 — Daily cron.** Build `api/cron/daily` (C.7) + `vercel.json` cron. *AC:* a dry run populates one event end-to-end (metrics + matured reaction + windowed sources) and commits once; a rate-limited vendor leaves prior values and flags staleness.
- **T9 — Frontend.** Overview (type-aware rows, freshness) + detail (metrics/surprise, guidance timeline, 4-horizon reaction, event sources with provenance chips + links). *AC:* every headline number links to its source; developer rows show catalyst, not earnings.
- **T10 — Auth.** Gate the app; read-only vs editor. *AC:* unauthenticated request blocked server-side.

`vercel.json` (example):
```json
{ "crons": [ { "path": "/api/cron/daily", "schedule": "0 6 * * 1-5" } ] }
```

### C.9 Connection manifest (agent quick-reference)
| Connection | Module | Endpoint(s) | Env | Key fn | Spec |
|---|---|---|---|---|---|
| Yahoo market data + news | `_yahoo` | query2 search/quoteSummary | — | `resolveSymbol`,`fetchDailyCloses`,`fetchTickerNews` | A.1,A.7 |
| SEC EDGAR | `_feedFetcher` | browse-edgar atom | — | `fetchOfficialSources` | A.2 |
| Newsfile / IR RSS | `_feedFetcher` | vendor RSS | — | `fetchOfficialSources` | A.3-A.4 |
| B3 Mziq | `_feedFetcher` | apicatalog.mziq POST | — | `fetchMziqDocuments` | A.5 |
| ABXX/SHLE HTML | `_feedFetcher` | IR page HTML | — | `parse*PressReleases` | A.6 |
| News fan-out | `_searchEngines`,`news`,`_yahoo` | GNews/Yahoo/Bing/GDELT/HN | — | `searchBing`,`fetchTickerNews` | A.7 |
| Article verify | `_articleVerifier` | publisher HEAD/GET | — | `verifyArticleUrl` | A.8 |
| X / FinTwit | `tweets` | Worker+TwitterAPI.io | `TWEET_WORKER_*`,`TWITTERAPI_IO_KEY` | — | A.9,B.2 |
| LLM enrich | `news`,`press-releases` | Anthropic messages | `ANTHROPIC_API_KEY` | `enrichWithClaude` | A.10 |
| Persistence | `_earningsStore` etc. | GitHub Contents | `GH_PAT` | `writeEarnings` | A.11 |
| Scheduler | `cron/daily` | Vercel Cron | — | handler | A/§I1 |
