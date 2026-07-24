# Backend PRD — BluOr Earnings & Catalyst Dashboard

*Draft v1.0. Companion to `PRD_Earnings_Catalyst_Dashboard.md` (project PRD) and
`FrontEnd_PRD_Earnings_Catalyst_Dashboard.md` (front-end PRD). This document
specifies the backend exhaustively: every API endpoint the shipped front-end
calls, the on-the-wire data shapes, the storage layer, auth, integrations, the
daily cron, the local backfill, and the failure/degradation matrix.*

## 0 · Table of Contents

1. [Executive summary](#1-executive-summary)
2. [Design commitments](#2-design-commitments)
3. [Canonical data model — wire shapes](#3-canonical-data-model--wire-shapes)
4. [Storage layer & commit-pipe](#4-storage-layer--commit-pipe)
5. [API endpoints](#5-api-endpoints)
6. [Authentication & authorization](#6-authentication--authorization)
7. [Integrations & third-party services](#7-integrations--third-party-services)
8. [Daily cron orchestration](#8-daily-cron-orchestration)
9. [Backfill & seeding](#9-backfill--seeding)
10. [Failure & degradation matrix](#10-failure--degradation-matrix)
11. [Environment variable manifest](#11-environment-variable-manifest)
12. [Front-end deltas required](#12-front-end-deltas-required)
13. [Migration path to Postgres](#13-migration-path-to-postgres)
14. [Open questions & IT asks](#14-open-questions--it-asks)
- [Appendix A — Wire-to-Postgres mapping](#appendix-a--wire-to-postgres-mapping)

---

## 1 · Executive summary

The backend serves an internal 17-name coverage dashboard for BluOr Asset
Management. It is a **daily-cron, poll-only, zero-webhook, no-OAuth** system.
For v1 the store is versioned JSON files committed to the same repo via the
GitHub Contents API (git-snapshot pattern). Every read endpoint reads the
deploy-baked snapshot; every write goes through a commit-pipe with optimistic
concurrency. All third-party vendor calls are server-side; secrets live only
in server env vars.

The front-end that already shipped assumes:
- one endpoint per data domain (`/api/earnings`, `/api/shared-state`, etc.)
- collapsed metric shape with named slots (`estimate`, `actual`, `prior`,
  `consensus`)
- a discriminated union for ETF vs earnings responses
- server-computed reaction points including `populatesOn` for pending horizons
- per-engine reachability info on every event's source window
- a stateless session cookie mapping to a `role ∈ {editor, readonly}`

This document specifies the backend to match exactly.

---

## 2 · Design commitments

Locked-in choices, keyed to the Q&A answered before this document:

| Ref | Decision | Consequence |
|---|---|---|
| **DC1 (Q1)** | The **entity registry** is the single source of truth for per-security config. **No standalone `BRIEF.md`.** Project PRD §A2 to be edited accordingly. | One file to maintain per name; two-source-drift eliminated. |
| **DC2 (Q2)** | **v1 store = git-snapshot** behind a **store repository interface**. Endpoints never call the GitHub Contents API directly; they call `store.readX / writeX / upsertX`. | Postgres swap is a store-module replacement, not a rewrite. |
| **DC3 (Q3)** | **Per-event verdict note**, single shared value, last-writer-wins, attributed with `lastEditedBy` + `lastEditedAt`. Not per-user. | Simple UX, matches Journey J2. |
| **DC4 (Q4)** | Wire shape is **collapsed named slots**: `metric.estimate`, `.actual`, `.prior`, `.consensus` each a `Fact`. Project PRD §6 remains the normalized model (Metric ← Fact[] with `role`); store layer maps between them. | No FE refactor; §6 stays valid as the future-Postgres schema. |
| **DC5 (Q5)** | **One read endpoint per domain**, discriminated union on `type`. `/api/earnings?ticker=X` returns `{ ticker, type, ... }` where the body varies. Same for the manual-entry write. | No endpoint proliferation. |
| **DC6 (Q6)** | Auth = **Microsoft Entra ID OIDC** (pending BluOr IT confirmation) → server-side session cookie → role from an Entra group. **Read-only vs editor is enforced server-side on every write.** | Bank-standard identity; sessions are the only client-visible auth artifact. |
| **DC7 (Q7)** | Trading calendars are **derived from each ticker's own returned price bars** — not from a market-calendar library at runtime. `_reaction.maturedHorizons` walks forward N trading bars using the security's + benchmark's intersected calendars. | $0, venue-agnostic, no library maintenance. `pandas_market_calendars` stays a local-backfill sanity check only. |
| **DC8 (Q8)** | **LLM enrichment ships OFF**. The provider interface exists; the flag is `false`. `articleType` is heuristic, no summaries, no `pt-en` translation. | Zero Anthropic spend in v1. |
| **DC9 (Q9)** | **No direct SEDAR+ retrieval** for v1. Newsfile + IR RSS covers Canadian names. A monitor flags any Canadian ticker with zero official-source items across a full quarter; only then do we revisit. | Accept a small known coverage gap; alarm if it fires. |
| **DC10 (Q10)** | Hosted mode serves **pre-rendered sanitized HTML with `<section id="para-N">` anchors** (backend renders once at ingest). Segment JSON is the annotation target internally. Third-party items are always link-out — never hosted. | 3× less client work; safe because hosting is restricted to primary sources. |
| **DC11 (Q11)** | **v1 ledger = git history + append-only `_ledger.jsonl`**. No in-app ledger view. `Data Status` panel already surfaces last-commit + freshness. | Ledger view = P2. |
| **DC12 (Q12)** | **Native currency stored on every Fact**. Backend does **not** auto-convert. `surprisePct` is computed only when estimate and actual share currency+unit; on mismatch, `surprisePct=null` + `unitMismatch=true` and FE renders `n/a — currency mismatch`. | Correct-by-construction; no invented FX rates. |
| **DC13 (Q13)** | Backfill scope = **~3 years daily bars + ~8 quarters past events per operating/developer name**. Reviewed at Phase 2 scale-out. *(User to confirm depth.)* | ~low-single-digit MB JSON — comfortably git-snapshot-safe. |
| **DC14 (Q14)** | Feedback has **two distinct actions**: `block_source` (hard exclude for all future windows) and `not_relevant_item` (downweight source's aggregate signal + hide the one item). Both durable, both reversible from `/admin/feedback`. | Preserves the reference `feedback.js` tier-updater semantics. |

---

## 3 · Canonical data model — wire shapes

These are the JSON shapes returned by API endpoints and persisted in
`data/*.json`. They are **identical** to what the shipped front-end expects
(`lib/types.ts` in the repo). The Postgres upgrade path is in Appendix A.

### 3.1 `Fact` (provenance wrapper)

```typescript
Fact = {
  value: number | string | null,    // string permitted for text values (e.g. "raised")
  unit: string,                      // "USD" | "USD_m" | "EUR" | "kt" | "USD/lb" | "%" | ...
  source: {
    url: string,
    label: string,
    provenance: "regulatory"|"ir-page"|"wire"|"news"|"social"|"independent",
    locator: string | null           // e.g. "para-4" → anchor id in a hosted Document
  } | null,
  asOf: ISO_DATE | null,
  fetchedAt: ISO_DATETIME | null,
  method: "yahoo"|"fmp"|"bloomberg_manual"|"filing_manual"|"llm_extracted",
  confidence: number                 // 0..1
}
```

`Fact` is **never overwritten** for the same field. Corrections create a
successor Fact and mark the prior as superseded (`supersededById`) — see 3.6.

### 3.2 `Entity` (registry entry)

`data/entity-registry.json` = `{ schema: "entity-registry/v1", entities: Entity[] }`.

```typescript
Entity = {
  ticker: string,                        // Bloomberg-style, e.g. "INTC US", "CS CN", "RIO PA"
  legalName: string,
  displayName: string,
  aliases: string[],
  exclusionAliases: string[],
  sectorTags: string[],
  cashtag: string | null,
  isCore: boolean,
  securityType: "operating" | "developer" | "etf",
  coverage: "deep" | "headline",
  listing: string,                       // "NASDAQ" | "TSX" | "Euronext Paris" ...
  currency: string,                      // ISO 4217 or "GBX" etc.
  benchmark: string,                     // ticker of the assigned reaction benchmark
  headlineMetrics: string[],             // canonical keys from data/metric-dictionary.json
  catalystTypes: string[],               // developer only; empty otherwise
  xHandle: string | null,                // Nitter proxy handle, e.g. "IntelNews"
  officialSources: OfficialSource[]      // A.2–A.6 per-ticker source registry
}

OfficialSource = {
  kind: "edgar" | "rss" | "mziq" | "html-abxx" | "html-shle",
  url: string,
  provenance: "regulatory" | "ir-page" | "wire",
  label: string,
  fmId?: string,                         // required when kind = "mziq"
  cik?: string                           // required when kind = "edgar"
}
```

**DC1 note:** everything the analyst configures per ticker lives here. No
per-ticker `BRIEF.md`.

### 3.3 `Metric` (collapsed, per DC4)

```typescript
MetricEntry = {
  key: string,                           // canonical, from metric-dictionary
  displayLabel: string,
  unit: string,
  isHeadline: boolean,
  isAdjusted: boolean | null,            // required for eps_* metrics
  surprisePct: number | null,            // null = n/a — no estimate OR unitMismatch=true
  unitMismatch: boolean,                 // DC12: true → surprisePct forced null
  estimate: Fact | null,
  actual: Fact | null,
  prior: Fact | null,
  consensus: Fact | null                 // populated when both a broker consensus AND a single-estimate exist
}
```

**DC4:** the four named slots are the wire shape. In the future Postgres
schema each slot maps to a row in `metric_facts` with `role IN
('estimate','actual','prior','consensus')`.

### 3.4 `Guidance`

```typescript
GuidanceEntry = {
  id: string,                            // stable UUID for supersede references
  key: string,
  displayLabel: string,
  period: string,                        // "FY2026" | "FY2026 Q2"
  basis: string,                         // "midpoint" | "reported" | "adjusted" | ...
  version: number,
  supersededById: string | null,
  move: "raised" | "held" | "cut" | "initiated" | "withdrawn" | null,
  low: Fact | null,
  high: Fact | null,
  midpoint: Fact | null                  // computed at ingest when low & high present + share unit
}
```

Backend **classifies `move`** on ingest by comparing to the immediately prior
non-superseded guidance for the same `(ticker, key, period, basis)`.

### 3.5 `Reaction`

```typescript
Reaction = {
  benchmark: string,
  baselineDate: ISO_DATE | null,
  baselineClose: number | null,
  timing: "BMO" | "AMC" | "intraday" | null,
  points: ReactionPoint[]
}

ReactionPoint = {
  horizon: "d1" | "d3" | "w1" | "m1",
  status: "pending" | "matured" | "terminal" | "gap",
  absReturn: number | null,
  excessReturn: number | null,
  benchmark: string,
  computedAt: ISO_DATETIME | null,
  populatesOn: ISO_DATE | null,          // pending-only; when the horizon will mature
  gapFlagged: boolean,                   // benchmark session missing → excess undefined
  terminalReason: "delisted" | "halted" | null  // E10, N1
}
```

**Baseline rule (DC7):** derived from the security's own returned bars.
- Timing `AMC` → baseline is the **next** trading bar after `eventDate`.
- Timing `BMO` → baseline is the **event-day** trading bar.
- Timing `intraday` → baseline is the **event-day** bar; excess vs benchmark
  same day.

**Horizon rule:** walk N intersected trading bars of security × benchmark. If
the benchmark's next N bars don't cover the security's N bars →
`gapFlagged=true`, `excessReturn=null`, `absReturn` still computed. (Addresses
edge case **E4**.)

**Terminal rule:** if the security stops trading before a horizon matures,
horizon flips to `status="terminal"` with `terminalReason ∈
{delisted, halted}`. (Addresses **E10**.)

### 3.6 `EventRecord`

```typescript
EventRecord = {
  id: string,                            // stable, e.g. "INTC_US_2026Q2"
  ticker: string,
  kind: "earnings" | "catalyst",
  period: string,
  scheduledDate: ISO_DATE,
  eventDate: ISO_DATE | null,            // set once the event actually occurs
  timing: "BMO" | "AMC" | "intraday" | null,
  catalystType: string | null,           // developer-only
  expectation: "below"|"inline"|"above"|"unset",
  guidanceMove: GuidanceMove | null,     // classification at the event level
  metrics: MetricEntry[],
  guidance: GuidanceEntry[],
  catalysts: CatalystDetail[],           // developer-only
  reaction: Reaction,
  sources: {
    windowStart: ISO_DATE,
    windowEnd: ISO_DATE,
    capturedAt: ISO_DATETIME | null,
    items: SourceItem[],
    engineStatus: EngineStatus[]         // per-engine reachability for the window
  },
  verdictNote: {
    text: string,
    lastEditedBy: string,                // Entra userPrincipalName (DC6)
    lastEditedAt: ISO_DATETIME
  } | null,
  supersededBy: string | null            // event-level supersede for restatements (E2)
}

SourceItem = {
  id: string,
  url: string,
  headline: string,
  source: string,
  provenance: Provenance,
  time: ISO_DATETIME,
  articleType: "news" | "opinion",
  engine: Engine,
  language: string,                      // "en" | "pt" | "fi" | ...
  hosted: boolean,                       // true → served by /api/documents/:id
  documentId: string | null,             // set when hosted
  summary: string | null,                // null in $0 mode (DC8)
  engagement?: { likes: number, reposts: number, replies: number }
}

EngineStatus = {
  engine: Engine,
  ok: boolean,
  lastGood: ISO_DATETIME | null,
  itemsFound: number                     // distinguishes "ok-but-empty" from "unreachable" (E6)
}

CatalystDetail = {
  type: string,                          // "PEA" | "Feasibility Study" | "Drill Result" | ...
  title: string,
  expectedDate: ISO_DATE | null,
  actualDate: ISO_DATE | null,
  expectation: Expectation,
  keyValues: { label: string, value: string }[],
  source: FactSource | null,
  scheduleHistory: { asOf: ISO_DATE, expectedDate: ISO_DATE }[]  // E16
}
```

**Restatements (E2):** a restated print creates a **new EventRecord** with the
same `period` and sets `supersededBy` on the prior record. The FE shows both
in the Events list; the security header shows the newest.

### 3.7 `EarningsSnapshot`

`data/earnings.json`:

```typescript
{
  schema: "earnings/v1",
  lastUpdated: ISO_DATETIME,
  events: EventRecord[],
  etfDetails: { [ticker: string]: EtfDetail }   // DC5: same file, keyed by ticker
}

EtfDetail = {
  price: Fact,
  distributions: EtfDistribution[],
  holdings: EtfHolding[],
  usedAsBenchmarkFor: string[]
}
```

`/api/earnings?ticker=X` returns a discriminated union:

```typescript
// operating | developer
{ ticker, type: "operating"|"developer", entity, events: EventRecord[], fetchedAt }

// etf
{ ticker, type: "etf", entity, etf: EtfDetail, fetchedAt }
```

### 3.8 `Document` (hosted mode — DC10)

`data/documents/{documentId}.html` = prerendered sanitized HTML with
`<section id="para-N">` anchors. Sidecar `data/documents/{documentId}.json`:

```typescript
{
  id: string,
  ticker: string,
  eventId: string | null,
  type: "transcript" | "press-release" | "mdna" | "filing",
  sourceUrl: string,
  hostedAt: ISO_DATETIME,
  ingestVersion: number,                 // increments if we re-render on source-change (N2)
  segments: Segment[]                    // annotation target index
}

Segment = {
  anchorId: string,                      // matches <section id> in the HTML
  speaker: string | null,
  speakerRole: string | null,
  section: "prepared" | "qa" | "body" | "table",
  paraIndex: number,
  text: string                           // plain text for search / pinpoint quote
}
```

The FE only ever loads the HTML + segments index. No client-side parsing.

### 3.9 `SharedState` (`data/shared-state.json`)

```typescript
{
  schema: "shared-state/v1",
  watchlist: string[],                   // tickers in analyst-chosen order
  customSources: CustomSource[],
  themes: Theme[],
  lastCommit: ISO_DATETIME
}

CustomSource = {
  id: string,
  kind: "rss" | "site-filter" | "twitter" | "substack",
  url: string,
  title: string,
  scope: { tickers: string[], themes: string[] },
  addedAt: ISO_DATETIME,
  addedBy: string,                       // Entra upn
  active: boolean,                       // DC14: enable/disable without deleting
  lastFetch: {
    at: ISO_DATETIME,
    ok: boolean,
    itemsFound: number,
    error: string | null
  } | null
}

Theme = { id: string, label: string, active: boolean }
```

### 3.10 `FeedbackLog` (`data/feedback-log.json`)

```typescript
{
  schema: "feedback/v1",
  entries: FeedbackEntry[]
}

FeedbackEntry = {
  id: string,
  target: "source" | "keyword" | "item",
  targetId: string,                       // domain for source, term for keyword, url for item
  action: "block_source" | "not_relevant_item" | "keyword_downweight" | "reverse",
  reason: string | null,
  createdBy: string,
  createdAt: ISO_DATETIME
}
```

DC14: `block_source` and `not_relevant_item` are the two user-facing actions;
`reverse` is issued from the Feedback admin to undo a prior signal.

### 3.11 `MetricDictionary` (`data/metric-dictionary.json`)

```typescript
{
  schema: "metric-dictionary/v1",
  metrics: {
    [canonicalKey: string]: {
      label: string,
      unit: string,
      requiresIsAdjusted: boolean,       // true for eps_*
      description: string | null
    }
  }
}
```

Admin "Add to dictionary" (FE PRD §7.9) writes here.

### 3.12 `Ledger` (`data/_ledger.jsonl`) — DC11

Append-only JSONL, one line per ingest/write. No FE view.

```typescript
{
  ts: ISO_DATETIME,
  op: "ingest" | "manual_entry" | "supersede" | "verdict" | "feedback" | ...,
  ticker: string | null,
  eventId: string | null,
  field: string | null,
  source: string | null,
  method: FactMethod | null,
  actor: string                          // "cron" | Entra upn
}
```

---

## 4 · Storage layer & commit-pipe

**DC2:** every endpoint uses a store repository. No endpoint knows we're on
git-snapshot.

```
api/*.ts  →  server/store.ts  →  server/stores/gitSnapshot.ts   (v1)
                            ↘   server/stores/postgres.ts       (upgrade)
```

### 4.1 Store interface

```typescript
interface Store {
  // Registry
  readRegistry(): Promise<Entity[]>
  writeRegistry(entities: Entity[]): Promise<void>

  // Earnings snapshot
  readEarnings(): Promise<EarningsSnapshot>
  upsertEvent(event: EventRecord): Promise<void>
  appendEventSources(eventId: string, items: SourceItem[], engineStatus: EngineStatus[]): Promise<void>
  setReactionPoint(eventId: string, point: ReactionPoint): Promise<void>
  supersedeEvent(oldId: string, newEvent: EventRecord): Promise<void>
  setVerdictNote(eventId: string, note: { text: string, editor: string }): Promise<void>
  setEtfDetail(ticker: string, detail: EtfDetail): Promise<void>

  // Shared state
  readSharedState(): Promise<SharedState>
  writeSharedState(state: SharedState): Promise<void>

  // Feedback
  readFeedback(): Promise<FeedbackLog>
  appendFeedback(entry: FeedbackEntry): Promise<void>

  // Metric dictionary
  readDictionary(): Promise<MetricDictionary>
  writeDictionary(dict: MetricDictionary): Promise<void>

  // Documents
  readDocument(id: string): Promise<{ html: string, meta: DocumentMeta }>
  writeDocument(id: string, html: string, meta: DocumentMeta): Promise<void>

  // Ledger
  appendLedger(entry: LedgerEntry): Promise<void>
}
```

### 4.2 Git-snapshot implementation (`gitSnapshot.ts`)

- **Reads**: read from the deploy-baked file (`fs.readFile` at server start,
  in-memory thereafter with a 60s revalidation).
- **Writes** flow through the reference `shared-state.js` commit-pipe:
  1. `GET https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<branch>`
     → base64 content + `sha`.
  2. Merge new state.
  3. `PUT` same path with `{ content, message, branch, sha }`.
  4. On `409` (stale SHA) → re-GET, re-merge, retry (max 3 attempts).
  5. On `503` / missing `GH_PAT` → return `{ ok: false, mode: "local-only" }`;
     the API endpoint bubbles this up so the FE renders the local-only banner.
- **Commit message** template: `store: {op} {ticker or eventId} · by {actor}`.
- **Concurrency guard**: an in-process mutex per file to avoid two parallel
  handlers racing on the same commit.

### 4.3 Optimistic-concurrency contract to the FE

- Write endpoints return `{ ok: true, commit: sha, mode: "synced" | "local-only" }`.
- On `409` after retries → HTTP 409 with `{ error: "conflict", latest: <newState> }`
  so the FE can toast "someone else saved first — refreshing" and reconcile.
- On `503` → HTTP 503 with `{ error: "persistence-unavailable" }`. FE queues
  locally and shows the amber "Local only" banner.

---

## 5 · API endpoints

Every endpoint is a Next.js Route Handler under `app/api/*/route.ts`. All
routes require a valid session (§6); write routes additionally require role
`editor`. All server-side vendor calls run only from these handlers or the cron.

### 5.1 Read endpoints

| Method | Path | Auth | Response | Cache |
|---|---|---|---|---|
| GET | `/api/shared-state` | session | `SharedState` | `s-maxage=60` |
| GET | `/api/entity-registry` | session | `Entity[]` | `s-maxage=300` |
| GET | `/api/metric-dictionary` | session | `MetricDictionary` | `s-maxage=3600` |
| GET | `/api/earnings?ticker=X` | session | discriminated union (§3.7) | `s-maxage=60` |
| GET | `/api/earnings?event=<id>` | session | single `EventRecord` | `s-maxage=60` |
| GET | `/api/earnings/snapshot` | session | full `EarningsSnapshot` (overview join) | `s-maxage=60` |
| GET | `/api/documents/:id` | session | `{ html: string, meta: DocumentMeta }` | `s-maxage=86400` (immutable per `ingestVersion`) |
| GET | `/api/feedback` | session | `FeedbackLog` | `s-maxage=60` |
| GET | `/api/health` | none | `{ ok, snapshotAt, ghPatPresent, engines: EngineStatus[] }` | `no-store` |

Notes:
- **`/api/earnings?ticker=X`** returns everything the security-detail view
  needs, including ETF shape (DC5). It reads `earnings.json` in-memory and
  filters, no external calls.
- **`/api/earnings/snapshot`** is what the overview page joins against the
  watchlist. Client caches ~60s.
- **`/api/documents/:id`** returns pre-rendered sanitized HTML (DC10) with a
  strong `ETag = documentId + ingestVersion`. Third-party items never resolve
  here — those go through the article verifier (§7).
- **`/api/health`** is unauthenticated because it's the readiness probe.

### 5.2 Search / discovery endpoints

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/api/ticker-lookup?q=X` | session | Yahoo `query2/v1/finance/search` per A.1 → `{ yahooSymbol, name, exchange } \| null`. Cached 15 min. |
| POST | `/api/discover-feed` | session | `{ url }` → `DiscoverFeedResult` per FE PRD §7.11. Reuses reference `discover-feed.js` verbatim. |
| GET | `/api/probe` | editor | Probes reachability of each engine from the current egress (A.9). Feeds the Settings › Data Status panel. |

### 5.3 Refresh-sources endpoints

Called by the "Refresh sources now" button (FE PRD §7.6, P6-T5). All
implemented as **fan-outs** the FE calls in parallel; each fails soft.

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/api/news?q=X&ticker=Y&from=<iso>` | session | Multi-engine fan-out (A.7), returns `SourceItem[]` + `EngineStatus[]`. |
| GET | `/api/press-releases?ticker=X&from=<iso>` | session | Official-sources fan-out per A.2–A.6, returns `SourceItem[]` + `EngineStatus[]`. |
| GET | `/api/tweets?ticker=X&handle=<h>&from=<iso>` | session | Nitter via Cloudflare Worker + TwitterAPI.io per A.9 & B, returns `SourceItem[]` + `EngineStatus[]`. |
| POST | `/api/events/:id/append-sources` | editor | Persists appended items after gate + dedup. Body: `{ items: SourceItem[], engineStatus: EngineStatus[] }`. Idempotent on `item.id`. |

The refresh flow: FE calls the three GETs in parallel → merges + dedups client
side → POSTs the merged batch. That keeps the fetches cache-friendly and puts
the persistence in one atomic write.

### 5.4 Write endpoints

| Method | Path | Auth | Body → response |
|---|---|---|---|
| PUT | `/api/shared-state` | editor | full `SharedState` → `{ ok, commit }`. 409 on stale SHA. |
| POST | `/api/entity-registry` | editor | `Entity` → `{ ok }` (creates). 409 if ticker exists. |
| PUT | `/api/entity-registry/:ticker` | editor | `Entity` → `{ ok, commit }`. 409 on stale registry. |
| DELETE | `/api/entity-registry/:ticker` | editor | `{ ok }`. Cascades: removes from watchlist, keeps historical events. |
| POST | `/api/metric-dictionary` | editor | `{ key, label, unit, requiresIsAdjusted }` → `{ ok }`. 409 on duplicate key. |
| POST | `/api/manual-entry` | editor | Manual-entry payload (§5.4.1) → `{ ok, factId }`. Blocks with 400 if `source` or `asOf` missing (I3). |
| PUT | `/api/events/:id/verdict-note` | editor | `{ text }` → `{ ok, lastEditedBy, lastEditedAt }`. Server stamps the editor from session. (DC3) |
| POST | `/api/events/:id/supersede` | editor | New `EventRecord` → `{ ok }`. Marks prior superseded (E2). |
| POST | `/api/feedback` | editor | `{ target, targetId, action, reason? }` → `{ ok }`. `action ∈ block_source \| not_relevant_item \| keyword_downweight \| reverse`. (DC14) |
| POST | `/api/cron/daily` | cron-secret | Kicks the daily orchestration (§8). Returns run summary. |

#### 5.4.1 Manual-entry payload

```typescript
POST /api/manual-entry
{
  ticker: string,
  eventId: string | null,        // null → creates event stub if none exists for the period
  period: string,
  metric: string,                // must be in the entity's headlineMetrics OR dictionary
  role: "estimate"|"actual"|"prior"|"consensus",
  value: number | null,
  unit: string,
  source: { url, label, provenance, locator? },   // REQUIRED (400 if missing)
  asOf: ISO_DATE,                                 // REQUIRED (400 if missing)
  method: "bloomberg_manual"|"filing_manual"|"llm_extracted",
  confidence: number,
  note: string | null
}
```

Server:
1. Verifies the metric key is in the dictionary or in the entity's
   `headlineMetrics`. If not → 400 (matches FE PRD §7.10 blocking rule).
2. Verifies `source` and `asOf` are present → else 400. **Nothing persists.**
3. Loads the existing MetricEntry for `(eventId, metric)`. If a Fact already
   exists in the same slot → the new one **supersedes** it. Old Fact keeps its
   own id in the ledger; the FE only sees the new one but the ledger shows
   both. (Fact-level version history.)
4. Recomputes `surprisePct` if the actual + estimate both exist and share unit
   (DC12 gate). Sets `unitMismatch=true` if not.
5. Appends a ledger entry.

### 5.5 Auth endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/login` | Redirects to Entra ID authorize URL (state + nonce, PKCE) |
| GET | `/api/auth/callback` | Handles OIDC callback, exchanges code, verifies id_token, sets session cookie |
| POST | `/api/auth/logout` | Revokes session cookie |
| GET | `/api/auth/me` | Returns `{ upn, name, role }` from session (used by the FE role provider) |

Details in §6.

### 5.6 Error envelope (all endpoints)

```typescript
{
  error: string,                 // machine-readable code
  message: string,               // human message for toast
  details?: unknown              // 400s include validation details
}
```

Non-obvious codes:
- `401 unauthenticated` — no session cookie.
- `403 forbidden` — read-only role attempted a write.
- `409 conflict` — stale SHA on commit-pipe write.
- `422 validation` — save blocked (e.g., manual entry missing source).
- `503 persistence-unavailable` — no `GH_PAT`.

---

## 6 · Authentication & authorization

**DC6:** Microsoft Entra ID (Azure AD) via OIDC. Pending BluOr IT confirmation
that (a) the tenant is Entra-based and (b) an "Signal-Editor" group can be
provisioned. See §14.

### 6.1 Session model

- **Provider:** Entra ID OIDC (auth code flow + PKCE).
- **Session:** signed, httpOnly, sameSite=lax cookie; JWT with `{ upn, name,
  role, exp }`; 8-hour lifetime; sliding refresh on activity within 30 min of
  expiry.
- **Signing key:** `AUTH_JWT_SECRET` env var (256-bit random).
- **CSRF:** double-submit token on all state-changing routes (`POST/PUT/DELETE`).

### 6.2 Role derivation

At `/api/auth/callback`:

1. Verify Entra id_token signature + audience + nonce.
2. Extract `upn`, `name`, `groups` claim (Entra "group membership claim" set
   to `SecurityGroup`).
3. If `groups` includes the `SIGNAL_EDITOR_GROUP_ID` (env) → `role = "editor"`,
   else → `role = "readonly"`.
4. Sign session JWT, set cookie, redirect to the `returnTo` parameter (or `/`).

**Failure:** if the user is not in the Entra tenant → 403 "not authorized"
(dead-end page, no auto-retry).

### 6.3 Server-side enforcement (never trust the client)

- **Middleware** (`middleware.ts` in Next) wraps every route except
  `/api/auth/*` and `/api/health`. Rejects requests without a valid session
  cookie → 401 → FE redirects to `/login`.
- **Write routes** additionally check `role === "editor"`. If not → 403. The
  FE hides admin nav in this case but must not be relied upon (FE PRD §M1).
- **Cron endpoint** `/api/cron/daily` bypasses the session gate but requires
  `Authorization: Bearer $CRON_SECRET`. Vercel Cron sets this automatically
  via `vercel.json`.

### 6.4 Bloomberg redistribution guard (E14, tentative)

If legal review comes back "Bloomberg values may only be seen by editors":

- Facts with `method = "bloomberg_manual"` are stripped from
  `role=readonly` responses server-side.
- FE renders `—` with the freshness dot flipped to grey ("not authorized").
- Flag: `RESTRICT_BLOOMBERG_TO_EDITORS` env var, default `false`.

Cost of building it now is small (a filter in the read endpoint); we build
the switch and leave it off.

---

## 7 · Integrations & third-party services

Every integration is **poll-only, server-side, no OAuth, no webhooks**.
Vendor quirks are fixed by project PRD Appendix A/B — reproduce exactly.

### 7.1 Registry of integrations

| # | Service | Purpose | Egress | Auth | Env vars | PRD ref |
|---|---|---|---|---|---|---|
| I1 | **Yahoo Finance `query2`** | prices, earnings dates, calendar, ticker lookup, ticker-news array | Vercel OK | none | — | A.1 |
| I2 | **SEC EDGAR** | Atom filings feed per CIK | Vercel OK | `User-Agent: BluOr Earnings Tracker <email>` | `EDGAR_CONTACT_EMAIL` | A.2 |
| I3 | **Newsfile RSS** | Canadian wire | Vercel OK | none | — | A.3 |
| I4 | **IR-page RSS** (Q4 + custom) | company IR headlines | Vercel OK | Chrome UA + `Accept-Language` | — | A.4 |
| I5 | **B3 Mziq** | Brazilian regulatory filings | Vercel OK | POST + `Origin` + `Referer` | — | A.5 |
| I6 | **ABXX / SHLE HTML** | fragile IR-page parsers | Vercel OK | Chrome UA | — | A.6 |
| I7 | **Google News RSS** | news fan-out | Vercel OK | UA `BluOrNewsTracker/1.0` | — | A.7 |
| I8 | **Bing News / GDELT / HN Algolia / think-tank RSS** | news fan-out | Vercel OK | none | — | A.7 |
| I9 | **Article verifier** (Google News redirect resolver) | resolve opaque `news.google.com/rss/articles/…` → publisher URL | Vercel OK | Range GET first 30 KB, concurrency 8 | — | A.8 |
| I10 | **X via Cloudflare Worker + Nitter** | company X posts | **Blocked from Vercel** → CF Worker proxy | `X-Auth: $TWEET_WORKER_SECRET` | `TWEET_WORKER_URL`, `TWEET_WORKER_SECRET` | A.9 |
| I11 | **TwitterAPI.io** | curated FinTwit search | Vercel OK | key header | `TWITTERAPI_IO_KEY` | A.9 |
| I12 | **Anthropic API** | LLM enrichment (OFF in v1, DC8) | Vercel OK | `x-api-key`, `anthropic-version: 2023-06-01` | `ANTHROPIC_API_KEY` | A.10 |
| I13 | **GitHub Contents API** | commit-pipe persistence | Vercel OK | fine-grained PAT | `GH_PAT`, `GH_REPO_OWNER`, `GH_REPO_NAME`, `GH_BRANCH` | A.11 |
| I14 | **FMP** | consensus fallback (only where Yahoo lacks) | Vercel OK | `apikey=` | `FMP_API_KEY` | §9 |
| I15 | **Microsoft Entra ID** | auth (§6) | Vercel OK | OIDC | `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `SIGNAL_EDITOR_GROUP_ID` | — |
| I16 | **Vercel Cron** | daily trigger | Vercel-internal | `Authorization: Bearer` | `CRON_SECRET` | §8 |

### 7.2 Vendor-specific rules the cron must follow

- **Rate limits** (§7 of project PRD): Yahoo/Google/Bing/GDELT are
  unauthenticated and rate-sensitive → cache aggressively via `s-maxage`.
  Article verifier concurrency ≤ 8, 6 s per-fetch timeout. FMP ≤ 250 req/day.
- **Copyright** (§11 project PRD): only company-posted / EDGAR / SEDAR
  primary sources are ever hosted; third-party → link-out only.
- **Fail-soft:** every fetch returns `[]` on any error and adds a row to
  `EngineStatus` with `ok: false`. Siblings keep running.
- **HTML parser monitoring:** if ABXX or SHLE returns zero items for 5
  consecutive days, `/api/health` flips that engine's status to `degraded`.

### 7.3 Cloudflare Worker (Nitter proxy)

- Deploy target: separate Cloudflare account owned by BluOr AM.
- Route: `GET /?nitter=<handle>&rss=1` → fetches `https://nitter.net/<handle>/rss`
  from a residential-like egress, returns the RSS body.
- Auth: `X-Auth` header equal to `TWEET_WORKER_SECRET`.
- Fallback plan: if Nitter breaks completely, we fall back to TwitterAPI.io
  for company posts too, at a per-call cost we currently avoid.

### 7.4 LLM provider interface (DC8, prepped but OFF)

```typescript
interface LLMProvider {
  enrichNews(items: RawNewsItem[]): Promise<EnrichedNewsItem[]>
  extractGuidance(text: string, context): Promise<GuidanceCandidate[]>
  classifyGuidanceMove(prior, next): Promise<GuidanceMove>
  summarizeSectorRead(memberEvents): Promise<SectorRead>
}
```

Implementations: `AnthropicProvider` (Haiku 4.5) is the default when
`LLM_ENABLED=true`. Ships `false`. The cron short-circuits — items go into
the snapshot un-enriched.

---

## 8 · Daily cron orchestration

`POST /api/cron/daily` — idempotent, safe to re-run. Triggered by Vercel Cron
per `vercel.json`. **DC7:** trading calendars derived from returned bars.

```
{ "crons": [ { "path": "/api/cron/daily", "schedule": "0 6 * * 1-5" } ] }
```

Multi-venue timing (E5): 06:00 UTC covers "yesterday's close" for NA + EU
venues after their sessions have ended; Asia is out of scope for v1.

### 8.1 Per-run steps

For each ticker in the watchlist:

1. **Symbol resolve** (Yahoo A.1) — 24h cached; store `yahooSymbol` + `name`.
2. **Fetch daily bars** (Yahoo A.1 `quoteSummary`) — one bar per session.
   Append to price cache. This is where the trading calendar is derived from.
3. **Fetch next-event meta** (Yahoo `earnings/calendarEvents` or developer
   registry catalyst dates) → upsert `Event.scheduledDate`.
4. **Detect new actual print**: if today's date ≥ scheduledDate AND we now
   have actuals via Yahoo/FMP OR a matching filing on EDGAR/Newsfile/Mziq →
   create/complete the Event:
   - Capture actuals as Facts.
   - Compute `surprisePct` per §3.3 rules (currency+unit match required, DC12).
   - Classify `guidance.move` by comparing to prior version.
   - Set `expectation` from Journey J2/J4 logic.
5. **Mature reaction horizons**: for each open Event, compute reaction points
   whose `populatesOn ≤ today` by walking bars (DC7). Set to `matured`;
   compute `absReturn`, `excessReturn`, `gapFlagged`.
6. **Event-window source polling**: for each Event with `windowStart ≤ today
   ≤ windowEnd`, run press-releases + news + tweets scoped to the entity's
   aliases. Gate via B.1 + B.2. Append to `event.sources.items` (dedup by URL
   + normalized headline). Update `engineStatus[]` for the day.
7. **Restatement detection**: if a matching filing carries a materially
   different actual than the persisted one → create a new EventRecord with
   `supersededBy` set (E2).
8. **Terminal-state check**: if a security stops trading before a horizon
   matures → mark that horizon `status="terminal"`, `terminalReason`.
9. **Persist**: single commit via `store.writeEarnings` (one commit per run).
10. **Ledger**: `store.appendLedger` per meaningful action.
11. **Health tick**: update `/api/health` payload.

Estimated wall time at 17 names: ~90 s (dominated by article verifier
concurrency).

### 8.2 What the cron does NOT do

- No LLM enrichment (DC8).
- No SEDAR+ direct retrieval (DC9).
- No hosted document rendering during the source-window poll — only at
  ingest of a company-posted / EDGAR primary source (DC10).
- No FX conversion (DC12).

---

## 9 · Backfill & seeding

`scripts/backfill.mjs` — run once, locally, from a residential IP (Yahoo
blocks Vercel datacenter IP for the historical-bars endpoint).

**Scope (DC13, pending confirmation):**
- ~3 years of daily bars per operating/developer/etf name.
- ~8 quarters of past events per operating/developer name (period, timing,
  primary IR press-release URL, transcript URL where hosted).

Approach: uses `yfinance` (Python) for bars + a manual sheet the analyst
maintains for past-event dates + URLs (Bloomberg-sourced). Writes into
`data/earnings.json` via the store interface (importable from Node scripts).

Restart-safe: keyed on `(ticker, period)`.

Storage estimate at DC13 scope: ~2–4 MB `earnings.json` — comfortably within
git-snapshot territory.

---

## 10 · Failure & degradation matrix

Every edge case from the diff, with the concrete backend behavior. Referenced
from §3 shapes.

| Edge case | Backend behavior |
|---|---|
| **E1 · Multiple currencies on one event** | Each Fact carries its native `unit`. `surprisePct` computed only when estimate.unit == actual.unit AND currency compatible. On mismatch → `surprisePct=null`, `unitMismatch=true`. FE renders "n/a — currency mismatch". |
| **E2 · Late-arriving actuals / restatements** | New `EventRecord` with same `period` and `supersededBy=<oldId>`. FE Events list shows both; header shows the newest. Ledger records both. |
| **E3 · Halt around print** | Baseline pinned to the first bar Yahoo returns post-halt. Reaction points set `gapFlagged=true` if the security's session count between event and horizon-target < N. `terminalReason=null` (not delisted). |
| **E4 · Benchmark not trading on the day** | Compute `absReturn` on the security. `excessReturn=null`, `gapFlagged=true`. FE renders "gap-flagged · benchmark session missing". |
| **E5 · Multi-venue cron timing** | Single cron at 06:00 UTC Mon–Fri. Freshness dots amber for any ticker whose venue's most recent session isn't yet reflected. Never blocks. |
| **E6 · Yahoo returns `news:[]`** | `EngineStatus.ok=true, itemsFound=0`. FE renders a subdued "no items from Yahoo Related" chip, distinct from `SourceUnavailableChip`. |
| **E7 · SEDAR+ gap** | Accepted for v1 (DC9). Monitor flags a Canadian ticker with zero official-source items over 90 rolling days. |
| **E8 · Cashtag collisions (`$BN` → Bambi)** | Entity registry `exclusionAliases` applied in `_tickerMatch.mentionsHolding` per B.1. Tweet skipped, not persisted. |
| **E9 · Hosted URL redirects to login wall** | Article verifier accepts on `og:type=article` — insufficient for these. Add heuristic: if resolved page < 2 KB text OR contains `<form.*password>` → mark `hosted=false`, keep as link-out with an inline "may require registration" hint. |
| **E10 · +1m horizon that never populates (delisting)** | `status="terminal"`, `terminalReason="delisted"`, `populatesOn=null`. FE renders "delisted before horizon" instead of "pending". |
| **E11 · Two editors save in the same second** | Commit-pipe 409 → second writer sees latest state → merge (field-level if resolvable, otherwise reject with `409 conflict, latest: <newState>` and toast). Verdict-note is last-writer-wins with `lastEditedBy` attribution (DC3). |
| **E12 · `GH_PAT` expires** | Every write returns 503. `/api/health` exposes `ghPatPresent: false`. FE persistent banner (already built). Recommended: rotate PAT quarterly + set an Entra reminder; PAT expiry is a known operational gap (§14). |
| **E13 · Anthropic key exhausted mid-window** | LLM is OFF in v1 (DC8). When it turns on: enrichment failures leave items un-enriched (`summary=null, articleType=heuristic`). FE already handles this. Add a `enrichmentAttempted: true, enrichmentSucceeded: false` field on `SourceItem` to distinguish from "never tried". |
| **E14 · Bloomberg redistribution** | Server-side filter: strip `method=bloomberg_manual` Facts from `role=readonly` responses when `RESTRICT_BLOOMBERG_TO_EDITORS=true`. FE handles gracefully (Facts shown as `—`). |
| **E15 · Rescheduled print shifts the source window** | On `scheduledDate` change, cron recomputes `windowStart = event − 2d` and `windowEnd = event + 35d`. Items outside the new window are kept (never truncate captured items). |
| **E16 · Developer catalyst repeatedly slips** | Every schedule change appends to `catalyst.scheduleHistory[]`. FE (future) can render a "slipped 3× — original Q3 2026" hint. |
| **N1 · Benchmark-security calendar intersection** | Formalized: for horizon `h ∈ {1,3,5,21}` sessions, walk `h` bars on the security. Take the closing date. Find the closest benchmark bar ≤ that date. If distance > 1 session → `gapFlagged=true`, `excessReturn=null`. |
| **N2 · IR page updates the press release in place** | Store `sourceContentHash` on Document ingest. Cron re-fetches company-posted press releases in the source window; if hash changes → new Document version, `ingestVersion++`. FE `/api/documents/:id` returns the latest; hosted-mode viewer shows an "updated <date>" chip. |
| **N3 · Entra group name** | Placeholder `SIGNAL_EDITOR_GROUP_ID`. See §14. |
| **N4 · Editor attribution privacy** | `lastEditedBy` returned as `upn` to editors; as `"analyst"` (opaque) to `readonly` viewers. Small concession to attribution comfort. |
| **N5 · Un-blocking a source** | `POST /api/feedback` with `action=reverse` referencing the prior entry's id. Backfill of items the block silently missed is out of scope for v1 — a manual "Refresh sources now" pass on affected events recovers the recent tail. |

---

## 11 · Environment variable manifest

| Var | Required | Used by | Purpose |
|---|---|---|---|
| `GH_PAT` | write ops | store/gitSnapshot | Fine-grained PAT, `Contents: Read & Write` on the one repo. |
| `GH_REPO_OWNER`, `GH_REPO_NAME`, `GH_BRANCH` | yes | store/gitSnapshot | Target repo/branch for commits. |
| `EDGAR_CONTACT_EMAIL` | yes | I2 EDGAR | Included in required `User-Agent` per A.2. |
| `TWEET_WORKER_URL` | tweets | I10 | Cloudflare Worker Nitter proxy URL. |
| `TWEET_WORKER_SECRET` | tweets | I10 | `X-Auth` shared secret. |
| `TWITTERAPI_IO_KEY` | optional | I11 | Curated FinTwit only; skipped if missing. |
| `FMP_API_KEY` | optional | I14 | Consensus fallback only; skipped if missing. |
| `ANTHROPIC_API_KEY` | optional (v1 OFF) | I12 | Only when `LLM_ENABLED=true`. |
| `LLM_ENABLED` | yes | LLM provider | `"false"` in v1 (DC8). |
| `ENTRA_TENANT_ID` | yes | Auth | Entra tenant. |
| `ENTRA_CLIENT_ID` | yes | Auth | Entra app registration. |
| `ENTRA_CLIENT_SECRET` | yes | Auth | Entra client secret. |
| `SIGNAL_EDITOR_GROUP_ID` | yes | Auth | Entra group ID mapped to `editor` role. |
| `AUTH_JWT_SECRET` | yes | Auth | 256-bit secret for session JWT. |
| `AUTH_COOKIE_DOMAIN` | yes | Auth | e.g. `signal.bluor.internal`. |
| `RESTRICT_BLOOMBERG_TO_EDITORS` | no (default `false`) | Auth filter | E14 legal-review flag. |
| `CRON_SECRET` | yes | Cron | Bearer token for `/api/cron/daily`. |

---

## 12 · Front-end deltas required

Small delta list the shipped front-end needs before backend live-mode goes on.
Each is an FE task, not a backend one, but they exist because of decisions in
§2.

| # | Delta | Reason |
|---|---|---|
| F1 | Extend `EarningsSnapshot.events` type to allow the ETF discriminated variant (`type: "etf", etf: EtfDetail`). Overview join must recognise both. | DC5. |
| F2 | Add `unitMismatch` handling in `SurprisePill` — render "n/a — currency mismatch" when set. | DC12 / E1. |
| F3 | Add `terminalReason` handling in `ReactionChart` — "delisted before horizon" instead of "pending". | E10. |
| F4 | Add `MetricEntry.consensus` slot rendering (a fourth column, or a variant of estimate). | DC4 + PRD §C1 open question (consensus vs single-estimate denominator). |
| F5 | Manual-entry form: scope metric selector to entity headline metrics; add `confidence`, `note`, "supersede" action. | I3 + FE PRD §7.10 gaps. |
| F6 | Add/Edit Security form: add `legalName`, `cashtag`, `isCore`, `xHandle`, official-sources editor, "Add to dictionary". | FE PRD §7.9 gaps. |
| F7 | Custom Sources: `enable/disable` toggle + `lastFetch` status per source. | FE PRD §7.11 gaps + DC14. |
| F8 | Feedback admin: three tables (Sources / Keywords / Items) with filters + export; distinguish `block_source` vs `not_relevant_item`. | FE PRD §7.12 + DC14. |
| F9 | Session provider: replace `RoleProvider` stub with a fetch to `/api/auth/me` on mount. | DC6. |
| F10 | Overview: click-through on a sparkline horizon → Event Detail (scroll-anchor). | FE PRD §7.2. |
| F11 | Watchlist row: expose FactPopover on the surprise cell. | FE PRD §7.2. |
| F12 | Data Status panel: render per-engine `EngineStatus` from `/api/health`. | FE PRD §7.14. |

---

## 13 · Migration path to Postgres

Trigger conditions:
- Phase-2 broad S&P 500 / EuroStoxx headline scan (500+ names → git-snapshot
  slows to unusable at one commit per write).
- Multi-editor concurrency conflicts exceeding one per day.
- Snapshot file > 10 MB (affects Vercel cold-start).

Migration:
1. Add `server/stores/postgres.ts` implementing the same `Store` interface.
2. Use Prisma schema in Appendix A. Seed from the last `earnings.json`.
3. Flip `STORE_BACKEND=postgres` env var. No endpoint changes.
4. Retire commit-pipe; the ledger becomes a table.

Timing: not v1. Explicitly out of scope until a trigger fires.

---

## 14 · Open questions & IT asks

Actionable, still open after Q&A:

| # | Question | Owner | Blocking? |
|---|---|---|---|
| OQ1 | **Confirm BluOr identity provider** is Entra ID / Azure AD (implied by @bluorbank.lv but must be verified). If not, we need to redesign §6. | BluOr IT | Yes for auth |
| OQ2 | **Provision Entra Enterprise App + `Signal-Editor` security group.** IT must return: tenant ID, client ID, client secret, group object ID, and admin consent for `openid profile email GroupMember.Read.All`. | BluOr IT | Yes for auth |
| OQ3 | **Confirm backfill scope (DC13):** 3 years bars + 8 quarters events per name. Deeper (10y bars, 20q events) makes the snapshot ~15 MB and starts to strain git-snapshot. | Analyst (Toms) | No (default assumed) |
| OQ4 | **Cloudflare Worker ownership** for Nitter proxy — BluOr AM CF account, or shared with the existing news-tracker? | Ops | Yes for tweets |
| OQ5 | **`TwitterAPI.io` account** — who owns the key, monthly cost ceiling? | Ops / Analyst | No (optional) |
| OQ6 | **Bloomberg redistribution legal review.** Sets `RESTRICT_BLOOMBERG_TO_EDITORS`. | Legal | No for build; toggle later |
| OQ7 | **Beat/miss denominator** when both consensus and single-estimate exist (project PRD §C1). Recommend: prefer consensus when available; fall back to single-estimate. | Analyst | No (default assumed) |
| OQ8 | **Reaction anchor for `intraday`-timed events** (e.g., pre-market announcements between BMO and market open). §3.5 uses event-day bar; confirm. | Analyst | No |
| OQ9 | **Cron time-of-day** — 06:00 UTC assumed. Confirm vs Vercel Hobby cron limits. | Ops | No |
| OQ10 | **Verdict-note visibility for `readonly`** — is the note shown to CIO/PM, or editor-only? DC3 implies shown to all; N4 obfuscates the author for readers. Confirm. | Analyst / CIO | No |

Anything marked "Yes" blocks a specific subsystem; the rest can be defaulted
and revisited.

---

## Appendix A — Wire-to-Postgres mapping

For when the migration trigger fires. The wire shapes (§3) map to a
normalized relational schema; the store layer handles the collapse/expand.

### A.1 Prisma model outline

```prisma
model Security {
  ticker           String   @id
  legalName        String
  displayName      String
  aliases          String[]
  exclusionAliases String[]
  sectorTags       String[]
  cashtag          String?
  isCore           Boolean
  securityType     SecurityType
  coverage         Coverage
  listing          String
  currency         String
  benchmark        String
  xHandle          String?
  metricDefs       MetricDef[]
  events           Event[]
  officialSources  OfficialSource[]
}

model MetricDef {
  id             String   @id @default(cuid())
  ticker         String
  canonicalKey   String
  displayLabel   String
  unit           String
  isHeadline     Boolean
  isAdjusted     Boolean?
  security       Security @relation(fields: [ticker], references: [ticker])
  @@unique([ticker, canonicalKey])
}

model Event {
  id             String   @id
  ticker         String
  kind           EventKind
  period         String
  scheduledDate  DateTime
  eventDate      DateTime?
  timing         Timing?
  catalystType   String?
  expectation    Expectation
  guidanceMove   GuidanceMove?
  metrics        Metric[]
  guidance       Guidance[]
  reaction       Reaction?
  sourceWindow   EventSourceWindow?
  verdictNote    VerdictNote?
  supersededById String?
  supersededBy   Event?   @relation("EventSupersede", fields: [supersededById], references: [id])
  successors     Event[]  @relation("EventSupersede")
  security       Security @relation(fields: [ticker], references: [ticker])
}

model Metric {
  id             String   @id @default(cuid())
  eventId        String
  canonicalKey   String
  isHeadline     Boolean
  surprisePct    Float?
  unitMismatch   Boolean  @default(false)
  event          Event    @relation(fields: [eventId], references: [id])
  facts          Fact[]
  @@index([eventId, canonicalKey])
}

model Guidance {
  id             String   @id
  eventId        String
  canonicalKey   String
  period         String
  basis          String
  version        Int
  supersededById String?
  move           GuidanceMove?
  event          Event    @relation(fields: [eventId], references: [id])
  facts          Fact[]
}

model Fact {
  id           String   @id @default(cuid())
  role         FactRole // estimate | actual | prior | consensus | guidance_low | guidance_high | note
  valueNum     Float?
  valueText    String?
  unit         String
  sourceUrl    String
  sourceLabel  String
  provenance   Provenance
  locator      String?
  asOf         DateTime?
  fetchedAt    DateTime?
  method       FactMethod
  confidence   Float
  metricId     String?
  metric       Metric?  @relation(fields: [metricId], references: [id])
  guidanceId   String?
  guidance     Guidance? @relation(fields: [guidanceId], references: [id])
  @@index([metricId, role])
  @@index([guidanceId, role])
}

model Reaction {
  eventId        String   @id
  benchmark      String
  baselineDate   DateTime?
  baselineClose  Float?
  timing         Timing?
  points         ReactionPoint[]
  event          Event    @relation(fields: [eventId], references: [id])
}

model ReactionPoint {
  id             String   @id @default(cuid())
  reactionId     String
  horizon        Horizon
  status         ReactionStatus
  absReturn      Float?
  excessReturn   Float?
  benchmark      String
  computedAt     DateTime?
  populatesOn    DateTime?
  gapFlagged     Boolean  @default(false)
  terminalReason TerminalReason?
  reaction       Reaction @relation(fields: [reactionId], references: [reactionId])
  @@unique([reactionId, horizon])
}

model EventSourceWindow {
  eventId      String   @id
  windowStart  DateTime
  windowEnd    DateTime
  capturedAt   DateTime?
  items        SourceItem[]
  engineStats  EngineStat[]
  event        Event    @relation(fields: [eventId], references: [id])
}

model SourceItem {
  id           String   @id
  windowEventId String
  url          String
  headline     String
  source       String
  provenance   Provenance
  time         DateTime
  articleType  ArticleType
  engine       Engine
  language     String
  hosted       Boolean
  documentId   String?
  summary      String?
  window       EventSourceWindow @relation(fields: [windowEventId], references: [eventId])
  @@index([windowEventId])
  @@index([url])
}

model EngineStat {
  windowEventId String
  engine        Engine
  ok            Boolean
  lastGood      DateTime?
  itemsFound    Int
  window        EventSourceWindow @relation(fields: [windowEventId], references: [eventId])
  @@id([windowEventId, engine])
}

model VerdictNote {
  eventId       String   @id
  text          String
  lastEditedBy  String
  lastEditedAt  DateTime
  event         Event    @relation(fields: [eventId], references: [id])
}

model Document {
  id             String   @id
  ticker         String
  eventId        String?
  type           DocumentType
  sourceUrl      String
  hostedAt       DateTime
  ingestVersion  Int
  sourceContentHash String
  segments       Segment[]
}

model Segment {
  id             String   @id @default(cuid())
  documentId     String
  anchorId       String
  speaker        String?
  speakerRole    String?
  section        SegmentSection
  paraIndex      Int
  text           String
  document       Document @relation(fields: [documentId], references: [id])
  @@unique([documentId, anchorId])
}

model Annotation {
  id             String   @id @default(cuid())
  documentId     String
  segmentAnchor  String?
  targetType     AnnotationTarget  // metric | guidance | sector_read | fact
  targetId       String
  pinpoint       String?           // ≤15-word quote per G2
  note           String?
  createdBy      String
  createdAt      DateTime  @default(now())
}

model FeedbackEntry {
  id        String   @id @default(cuid())
  target    FeedbackTarget
  targetId  String
  action    FeedbackAction
  reason    String?
  createdBy String
  createdAt DateTime @default(now())
}

model Ledger {
  id        String   @id @default(cuid())
  ts        DateTime @default(now())
  op        String
  ticker    String?
  eventId   String?
  field     String?
  source    String?
  method    FactMethod?
  actor     String
}
```

### A.2 Mapping the collapsed wire shape

```
wire.MetricEntry.estimate   ↔  Metric + Fact where role = estimate
wire.MetricEntry.actual     ↔  Metric + Fact where role = actual
wire.MetricEntry.prior      ↔  Metric + Fact where role = prior
wire.MetricEntry.consensus  ↔  Metric + Fact where role = consensus
wire.GuidanceEntry.low      ↔  Guidance + Fact where role = guidance_low
wire.GuidanceEntry.high     ↔  Guidance + Fact where role = guidance_high
wire.GuidanceEntry.midpoint ↔  computed at read: (low.value + high.value)/2
                               when low.unit == high.unit
```

Round-trip: `store.upsertEvent(wireEvent)` expands into
Metric/Fact/Guidance/Fact rows; `store.readEarnings()` collapses them back.
The collapse function is the only place that needs to know both shapes.

---
