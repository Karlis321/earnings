# Wire-Up Plan — BluOr Earnings & Catalyst Dashboard

*Draft v1.0. Companion to `Backend_PRD_Earnings_Catalyst_Dashboard.md`. Phases the
integration of the shipped front-end with the yet-to-be-built backend, with a
testing checkpoint after every phase.*

## 0 · Baseline

**Front-end (already shipped).** Every data access goes through
`lib/apiClient.ts`. Live-mode calls throw a specific error naming the endpoint
that isn't wired yet. The FE compiles, type-checks, and runs entirely on
fixtures. The seam to flip is `FEATURE_FLAGS.liveMode` in `lib/flags.ts`.

**Backend (this repo).** Zero endpoints implemented. Store interface,
schemas, and endpoint contracts spec'd in the Backend PRD.

**Wire-up strategy.** We do NOT flip `liveMode` globally to true. Instead:

1. Implement one endpoint (or one small group).
2. Change *only that method* in `apiClient.ts` to fetch instead of throw.
3. Every other method still returns fixtures. The app keeps working.
4. Test to the checkpoint. Fix. Repeat.

This means the FE is always usable, live and fixture data can co-exist during
transition, and rollback of any single endpoint is a one-line revert.

**Two supporting patterns baked in from day one:**

- **Per-method live flag** — `apiClient.ts` gains `FEATURE_FLAGS.live.<method>`
  granularity. `FEATURE_FLAGS.liveMode` becomes a "flip all" convenience.
- **Fixture parity tests** — every fixture in `lib/fixtures/` has a
  corresponding schema check that must pass on both the fixture AND the live
  response. That's how we catch shape drift (§10 in Backend PRD).

---

## 1 · Front-end component → API endpoint map

Complete map of every wired point. Order = integration order (see §2).

| FE component / route | Uses `apiClient` method | Backend endpoint | Read/Write | Wire-up phase |
|---|---|---|---|---|
| `Header.SessionPill` | `getSession()` (new) | `GET /api/auth/me` | R | **W0** |
| `RoleProvider` | `getSession()` | `GET /api/auth/me` | R | **W0** |
| `/login` | `signIn()` (new) | `GET /api/auth/login` | R (redirect) | **W0** |
| `Header.SecuritySwitcher` + `/admin/securities/*` | `getEntities()` | `GET /api/entity-registry` | R | **W1** |
| `Overview` filter/sort/group by sector | `getEntities()` (sectorTags) | `GET /api/entity-registry` | R | **W1** |
| `/sectors`, `/sectors/:id` | `getEntities()` | `GET /api/entity-registry` | R | **W1** |
| `WatchlistTable` | `getSharedState()` + `getWatchlist()` | `GET /api/shared-state` + `GET /api/earnings/snapshot` | R | **W1 + W2** |
| Header `DataStatusPill` | `getSnapshot()` (already exists) | `GET /api/earnings/snapshot` | R | **W2** |
| `AddEditSecurityForm` "metrics catalog" | `getDictionary()` (new) | `GET /api/metric-dictionary` | R | **W1** |
| `SecurityDetailPage` (operating/dev/etf) | `getEventsForTicker(t)` | `GET /api/earnings?ticker=X` | R | **W2** |
| `EventDetailPage` | `getEvent(id)` | `GET /api/earnings?event=X` | R | **W2** |
| `EtfDetail` | `getEtfDetail(t)` (folded into discriminated union) | `GET /api/earnings?ticker=X` (etf variant) | R | **W2** |
| `GlobalSearch` typeahead | (client) `getEntities()` | (already covered) | R | **W1** |
| `GlobalSearch` unknown-ticker resolve | `tickerLookup(q)` (new) | `GET /api/ticker-lookup` | R | **W4** |
| `AddEditSecurityForm` "Resolve" button | `tickerLookup(q)` | `GET /api/ticker-lookup` | R | **W4** |
| `VerdictNote` autosave | `putVerdict(eventId, text)` (new) | `PUT /api/events/:id/verdict-note` | W | **W3** |
| `SourcesPanel` "Refresh sources now" | `refreshSources(eventId)` | three parallel GETs (see W5) + `POST /api/events/:id/append-sources` | R+W | **W5** |
| `SourceItemCard` feedback | `postFeedback(...)` | `POST /api/feedback` | W | **W3** |
| `/admin/feedback` listing | `getFeedback()` (new) | `GET /api/feedback` | R | **W3** |
| `/admin/sources` Discover | `discoverFeed(url)` | `POST /api/discover-feed` | R | **W4** |
| `/admin/sources` Save | `putSharedState(...)` (new) | `PUT /api/shared-state` | W | **W4** |
| `AddEditSecurityForm` Save (new) | `postEntity(entity)` (new) | `POST /api/entity-registry` | W | **W4** |
| `AddEditSecurityForm` Save (edit) | `putEntity(ticker, entity)` (new) | `PUT /api/entity-registry/:ticker` | W | **W4** |
| `AddEditSecurityForm` "Add to dictionary" (new UI) | `postDictionaryKey(k)` (new) | `POST /api/metric-dictionary` | W | **W4** |
| `ManualEntryForm` | `postManualEntry(payload)` (new) | `POST /api/manual-entry` | W | **W4** |
| `SourceViewer` hosted mode | `getDocument(id)` (new) | `GET /api/documents/:id` | R | **W7** |
| `Settings › Data Status` | `getHealth()` (new) | `GET /api/health` | R | **W6** |
| Daily refresh trigger (system) | — | `POST /api/cron/daily` (cron-secret) | W | **W6** |
| Reaction horizon maturation | — | (internal to `/api/cron/daily`) | W | **W6** |

New `apiClient` methods to add: `getSession`, `signIn`, `getDictionary`,
`postDictionaryKey`, `tickerLookup`, `putVerdict`, `getFeedback`, `postEntity`,
`putEntity`, `postManualEntry`, `putSharedState`, `getDocument`, `getHealth`.

---

## 2 · Integration order (why this order)

Ordering rule: **prereqs first, cheap-and-static reads before expensive
fetches, writes only after auth**. Each phase is small, each ends at a
checkpoint that catches shape drift before it compounds.

```
W0  Auth + infra                    ─┐
W1  Static reads (registry, dict)    │  reads
W2  Earnings snapshot reads          │
W3  Simple writes (verdict, feedback)┤
W4  Admin writes (registry, entry)   ┤  writes
W5  Refresh-sources fan-out          │  fan-out
W6  Cron + health                    │  automation
W7  Documents + hosted mode          ┤  hosted
W8  Backfill + cutover               ─┘  go-live
```

- **W0 first** because every other route is behind the session middleware.
- **W1 before W2** because the snapshot join needs registry to resolve
  security types (op vs dev vs etf drives which fields render).
- **W3 before W4** because verdict-note is the smallest write path — proves
  the commit-pipe end-to-end before we take on the more complex admin writes.
- **W5 after W4** because refresh-sources involves three vendor fan-outs +
  the append endpoint; we want auth and the write path stable first.
- **W6 after W5** because the cron does everything W5 does but headless.
- **W7 near the end** because hosted-mode requires ingest-time rendering, a
  separate concern from the read path.
- **W8 last** because backfill runs once, from a residential IP, and populates
  the initial `earnings.json` — the moment of "we're on live data now".

---

## 3 · Phase-by-phase spec

Each phase lists: scope, endpoints implemented, FE changes, **data
transformation / debugging risks** (what will bite), and a **testing
checkpoint**.

### W0 · Auth + infra
**Goal:** signed-in users hit the app; role drives admin visibility.

Scope:
- Entra ID Enterprise App registered (OQ1/OQ2 in Backend PRD §14 must be
  resolved before this phase can start).
- Middleware (`middleware.ts`) that redirects unauthenticated requests to
  `/api/auth/login`, exempts `/login`, `/api/auth/*`, `/api/health`,
  `/api/cron/daily`.
- Endpoints: `GET /api/auth/login`, `GET /api/auth/callback`, `POST
  /api/auth/logout`, `GET /api/auth/me`.
- Store layer skeleton: `server/store.ts` + `server/stores/gitSnapshot.ts`
  reading local files (writes deferred to W3).
- `/api/health` returning `{ ok, snapshotAt, ghPatPresent: bool }`.

FE changes:
- `RoleProvider` fetches `/api/auth/me` on mount instead of using the stub.
- `LoginPage` links to `/api/auth/login`.
- `middleware.ts` redirect keeps SSR pages behind the gate.

**Data-transformation risks / debug areas:**
- Entra `groups` claim can arrive as `groupIds` or as a Graph pointer if the
  group count exceeds the token limit (~150 groups). Handle both: if a
  `_claim_names.groups` overage indicator is present, call MS Graph
  `/me/getMemberGroups` to resolve. This is Graph-quirk territory.
- Session-cookie domain settings differ between preview URLs
  (`*.vercel.app`) and prod (`signal.bluor.internal`). Cookie must be scoped
  correctly or the auth callback will loop.
- Clock skew on JWT `exp` vs Vercel-region time causes intermittent 401s.
  Add 60 s leeway in verification.

**Testing checkpoint W0.T1:**
1. Curl `/api/health` unauthenticated → 200 with `ok: true`.
2. Curl `/` unauthenticated → 302 to `/api/auth/login`.
3. Sign in as an editor → cookie present, `/api/auth/me` returns
   `{ upn, name, role: "editor" }`, admin tab visible.
4. Sign in as a read-only user → `role: "readonly"`, admin tab hidden, `PUT
   /api/shared-state` returns 403 even with a manual curl.
5. Restart the server → sign-in state persists (session cookie), no
   re-login required.

**Rollback**: revert `middleware.ts` + `RoleProvider` to stub. FE remains
usable.

---

### W1 · Static reads (registry, shared-state, dictionary)
**Goal:** the overview, sectors, and admin config pages read live registry data.

Scope:
- Endpoints: `GET /api/entity-registry`, `GET /api/shared-state`, `GET
  /api/metric-dictionary`.
- `data/entity-registry.json` seeded from `lib/fixtures/registry.ts` (one-time
  script). Adds the fields the FE currently doesn't send (`legalName`,
  `cashtag`, `isCore`, `officialSources`, `xHandle`) — see F6 in Backend PRD.
- `data/metric-dictionary.json` seeded from `METRIC_LABELS`.
- Store layer read path via `gitSnapshot.ts`, no writes yet.

FE changes:
- `apiClient.getEntities`, `getSharedState`, `getDictionary` methods flipped
  to fetch.
- `AddEditSecurityForm` extended: `legalName`, `cashtag`, `isCore`,
  `xHandle`, and the official-sources list editor (F6).

**Data-transformation risks / debug areas:**
- Ticker format: FE emits `"INTC US"` (Bloomberg-style with space). URL
  encoding matters — the client uses `encodeURIComponent`. Verify the API
  route decodes `%20` back to a space, not to `+`.
- Deploy-baked JSON: on Vercel, `fs.readFile` reads the built artifact.
  Local dev reads from disk directly. Watch for path-resolution differences
  between `process.cwd()` and `__dirname` — use one consistently.
- `sectorTags` may contain hyphenated keys; slug logic in URL routes
  (`/sectors/us-large-cap`) has to survive round-tripping.

**Testing checkpoint W1.T1:**
1. `GET /api/entity-registry` returns all 17 entities.
2. Overview renders identically to fixture mode (visual QA).
3. Sectors page counts match `data.getSectors()` output.
4. `/admin/securities/CS%20CN` loads and renders `CS CN`'s fields.
5. Add a new sector tag to one entity file → overview updates on next request
   (no client reload past the 60s cache TTL).

---

### W2 · Earnings snapshot reads
**Goal:** the security-detail and event-detail views render live data.

Scope:
- Endpoints: `GET /api/earnings?ticker=X`, `GET /api/earnings?event=X`, `GET
  /api/earnings/snapshot`.
- Discriminated union response (DC5) — one endpoint, ETF vs earnings shape by
  `type`.
- `data/earnings.json` seeded from `lib/fixtures/earnings.ts` (one-time
  script), including the `etfDetails` block folded in.
- Store `readEarnings()` returning `EarningsSnapshot`.

FE changes:
- `apiClient.getEventsForTicker`, `getEvent`, `getEtfDetail`, `getSnapshot`
  flipped.
- Type extension: FE `EarningsSnapshot.events` union includes ETF variant
  (F1 in Backend PRD).
- `SurprisePill` renders "n/a — currency mismatch" when
  `unitMismatch=true` (F2).
- `ReactionChart` renders "delisted before horizon" when
  `terminalReason=delisted` (F3).
- `MetricEntry.consensus` slot rendered where present (F4).

**Data-transformation risks / debug areas:**
- **The biggest risk of the whole plan.** The FE's `MetricEntry.estimate` /
  `.actual` etc. are `Fact | null`. The Backend PRD `Fact.value` allows
  `number | string | null`. The current FE only handles `number | null`.
  Coercion of guidance-move text and expectation strings needs to land here.
- Reaction points: FE currently treats `absReturn: null` as "pending". Backend
  now sends `status: pending | matured | terminal | gap`. The FE branching
  must switch to reading `status` explicitly — leaving `null`-based logic in
  place will misclassify terminal + gap horizons.
- Freshness: the backend never sends `event.freshness`; the FE computes it
  live via `computeFreshness`. Remove the field from any code that reads it.
- ETF `usedAsBenchmarkFor`: currently seeded empty. Backend must join
  registry `benchmark` fields to populate. Cheap step, but if omitted the
  ETF detail loses its "used as benchmark for" pills.

**Testing checkpoint W2.T1:**
1. `GET /api/earnings?ticker=INTC%20US` returns 1 event, matches fixture.
2. `GET /api/earnings?ticker=GDXJ%20US` returns `type: "etf"` with the ETF
   detail body.
3. Overview freshness dots all render green (fixture data pretends "today"
   is 2026-07-24; local dev clock will drift dots amber — that's OK).
4. Security-detail INTC US shows the beat pill on Revenue and the miss pill
   on EPS.
5. Event-detail for `INTC_US_2026Q2` shows 3 matured horizons + `m1` pending.
6. Restart the server; refresh a page; no client-side error.

**Regression tests to add:**
- Every fixture in `lib/fixtures/earnings.ts` has a shape-parity test that
  validates it matches the backend's response schema. Run this in CI.

---

### W3 · Simple writes (verdict note, feedback)
**Goal:** proves the commit-pipe end-to-end. Least-risk write endpoints first.

Scope:
- Endpoints: `PUT /api/events/:id/verdict-note`, `POST /api/feedback`,
  `GET /api/feedback`.
- Store: `setVerdictNote`, `appendFeedback`, `readFeedback` — first real
  commit-pipe writes.
- 409-retry + 503-fallback logic in `gitSnapshot.ts` (see Backend PRD §4.2).

FE changes:
- `apiClient.putVerdict`, `postFeedback`, `getFeedback` flipped.
- `VerdictNote` triggers `putVerdict` on save; toast on success; 409-toast on
  conflict with "someone else saved first — retry" and auto-refetch.
- `SourceItemCard` feedback buttons: "not relevant" → `not_relevant_item`;
  "block source" → `block_source` (DC14 semantics from Backend PRD).
- `Feedback` admin table renders the two action types distinctly.

**Data-transformation risks / debug areas:**
- **GitHub Contents API 409 storms.** Two editors on the same event will
  race. Test this deliberately (see checkpoint). The retry loop must
  re-fetch, re-merge on the correct field, and not clobber the other
  editor's unrelated changes.
- **Commit-message noise.** Every keystroke autosave would spam commits.
  Debounce autosave 1.5 s on the FE; batch commits on the backend to at
  most 1/second per file.
- **Local-only mode**: if `GH_PAT` is missing → all writes return 503 → FE
  banner. Make sure the banner appears BEFORE the write throws (health
  check on session).
- **Attribution privacy (N4)**: `lastEditedBy` returned as upn to editors,
  opaque to readonly. Add the filter in the read endpoint.

**Testing checkpoint W3.T1:**
1. Editor writes verdict note; ~1.5s later a commit appears in git history
   with the correct message pattern.
2. Refresh the page; the note persists.
3. Read-only session opens same event; note shown, "add note" affordance
   absent; direct `PUT` returns 403.
4. Two editors save conflicting notes within 2 seconds → later one wins,
   earlier one receives a 409-toast and re-fetches.
5. Toggle `GH_PAT` off (rename in env) → banner appears within 60 s;
   attempting to save writes to localStorage only; no data loss on the
   subsequent toggle-back.
6. Feedback: mark an item not-relevant → new entry appears in
   `/data/feedback-log.json`; block a source → same table row shows
   `action=block_source`.

---

### W4 · Admin writes (registry, manual entry, custom sources)
**Goal:** every admin surface is live-writable.

Scope:
- Endpoints: `POST /api/entity-registry`, `PUT /api/entity-registry/:ticker`,
  `DELETE /api/entity-registry/:ticker`, `POST /api/manual-entry`,
  `PUT /api/shared-state`, `POST /api/discover-feed`, `POST /api/metric-dictionary`,
  `GET /api/ticker-lookup`.

FE changes:
- `apiClient.postEntity`, `putEntity`, `postManualEntry`, `putSharedState`,
  `discoverFeed`, `postDictionaryKey`, `tickerLookup` flipped.
- `AddEditSecurityForm` "Resolve" button hits `/api/ticker-lookup` and
  auto-fills name/exchange (F6).
- `AddEditSecurityForm` "Add to dictionary" affordance (F6).
- `ManualEntryForm` extended with `confidence`, `note`, supersede-version
  history table (F5).
- Custom sources: `active` toggle + `lastFetch` status per source (F7).

**Data-transformation risks / debug areas:**
- **Ticker lookup name-collision.** `AAPL` search returns Apple + a dozen
  bitcoin/derivative products with the same symbol. Backend must filter to
  `quoteType=EQUITY` and prefer venue-matching exchange per A.1's exchange
  mapping. If it doesn't, admin will resolve `RIO PA` to the wrong Rio.
- **Manual-entry validation**. Mandatory `source` + `asOf` → 400 with a
  useful validation payload. FE renders inline errors per field. Test
  every failure mode (missing source, invalid date, unknown metric).
- **Metric-key gating.** Backend rejects free-form metric keys; FE's "Add to
  dictionary" is the escape hatch. If dictionary POST fails silently, the
  admin gets stuck.
- **Discover-feed**: substack and X account URLs. The reference
  `discover-feed.js` classifies these — but Substack notes vs profiles vs
  publications produce different `kind` values. Test each URL family.
- **Registry write atomicity.** Writing an `Entity` change re-writes the
  whole `entity-registry.json`. If two editors edit different tickers
  simultaneously, both must not drop the other's change on 409-retry. Merge
  by ticker key.

**Testing checkpoint W4.T1:**
1. Add new security via UI (ticker `XYZ US`) → resolves → saves →
   overview shows the new row (data-incomplete flag until first refresh).
2. Manual-entry save without `source` → inline error, nothing persists,
   ledger empty.
3. Manual-entry save with all fields → new Fact in the event's metric slot,
   ledger line appended, freshness dot green.
4. Custom source: paste a WSJ URL → discover returns `site-filter` with the
   Google News fallback note; save → `active: true` in shared-state.
5. Add a new metric to the dictionary → available in the AddEdit form's
   headline-metric selector on refresh.
6. Delete a security (with a confirm dialog) → removed from watchlist,
   historical events retained.
7. Try `POST /api/entity-registry` as read-only → 403.

---

### W5 · Refresh-sources fan-out
**Goal:** "Refresh sources now" on an event pulls fresh items from all three
vendor families.

Scope:
- Endpoints: `GET /api/news`, `GET /api/press-releases`, `GET /api/tweets`,
  `POST /api/events/:id/append-sources`.
- Ports from the reference news-tracker: `_html`, `_feedFetcher`,
  `_officialSources`, `_searchEngines`, `_articleVerifier`, `_tickerMatch`,
  `_tweetQuality`, `_finTwitAccounts`, `_yahoo` (search + news array from A.1).
- Cloudflare Worker for Nitter — deploy separately, register
  `TWEET_WORKER_URL` + `TWEET_WORKER_SECRET`.

FE changes:
- `apiClient.refreshSources(eventId)` orchestrates the three parallel GETs +
  merges + dedupes + POSTs to append.
- `SourcesPanel` renders per-engine progress + `EngineStatus[]` result row +
  a summary toast.

**Data-transformation risks / debug areas:**
- **The single most fragile area.** Vendor quirks per Appendix A:
  - **EDGAR** requires the `User-Agent: BluOr Earnings Tracker <email>`
    header. Missing → 429 within seconds.
  - **Q4 IR feeds** (Century, Hudbay) 403 non-browser UAs. Use current
    Chrome UA + `Accept-Language`.
  - **B3 Mziq** requires POST + `Origin: https://ri.b3.com.br`. GET returns
    a misleading 401.
  - **ABXX/SHLE** HTML parsers break on ANY site redesign — must fail soft
    to `[]`.
  - **Google News redirect URLs** are opaque — must resolve via article
    verifier (concurrency 8, 6 s timeout).
- **Deduplication** by URL then by normalized headline (drop trailing "—
  Publisher", strip punctuation/stopwords, sort words) — port the reference
  logic verbatim.
- **`mentionsHolding` false positives** (`$BN` → Bambi). B.1 exclusion
  aliases must actually be applied by the tweet path.
- **Nitter proxy fragility**. Nitter instances break periodically. If the
  proxy returns non-200 for > 5 min, `EngineStatus.ok=false` +
  `SourceUnavailableChip`.
- **Rate limits**. Google News RSS + Bing + GDELT all unauthenticated and
  will throttle without notice. Cache with `s-maxage=600,
  stale-while-revalidate=3600` per A.7.

**Testing checkpoint W5.T1:**
1. `GET /api/press-releases?ticker=INTC%20US` returns ≥1 EDGAR item.
2. `GET /api/press-releases?ticker=CENX%20US` returns 200 with Q4 IR feed
   (browser UA), non-zero items.
3. `GET /api/news?q=Capstone+Copper` returns deduped items across engines;
   a `site:reuters.com` query resolves the redirect to a `reuters.com/…`
   URL (not `news.google.com/…`).
4. `GET /api/tweets?ticker=BN%20US&handle=Brookfield` returns tweets via the
   Cloudflare Worker; `mentionsHolding('$BN closed up', 'BN US')` filter
   works; "Bambi" tweets excluded.
5. In the FE: open an event → "Refresh sources now" → progress spinner per
   engine → items appended with dedup, engine-status row updated, one
   engine intentionally down (e.g., invalid Worker URL) → shows
   `SourceUnavailableChip`, siblings still return items.
6. `POST /api/events/:id/append-sources` is idempotent — replay same payload
   → no duplicate items.
7. Simulate a rate-limit: Google News returns 429 → engine flagged, no
   crash, cached items still shown.

**Regression tests:** for every vendor, a fixture-response fixture in
`test/vendor-fixtures/` + a parser test — because vendor HTML/RSS is where
the reference code learned its lessons.

---

### W6 · Cron + health
**Goal:** end-to-end automation. The dashboard updates itself daily.

Scope:
- Endpoint: `POST /api/cron/daily` (cron-secret auth).
- Orchestration per Backend PRD §8 (symbol resolve → bars → next-event →
  detect print → mature horizons → source-window poll → persist → ledger).
- Trading calendar derived from returned bars (DC7).
- `vercel.json` cron schedule: `0 6 * * 1-5`.
- `/api/health` upgraded to include `engines: EngineStatus[]` from the last
  run.

FE changes:
- `apiClient.getHealth` flipped.
- Settings › Data Status panel renders live health data (F12).
- Header `DataStatusPill` reflects real `lastUpdated`.
- "Stale refresh" banner triggers when `now - lastUpdated > 26h` on a
  weekday.

**Data-transformation risks / debug areas:**
- **Idempotence.** Cron can be re-run manually (or by Vercel on retry). Every
  step must be safe on repeat: `upsertEvent` (not `insertEvent`),
  `setReactionPoint` (not `pushReactionPoint`), `appendEventSources` dedup
  by `item.id`.
- **Timezone bug hotspot.** All internal dates in ISO 8601 UTC, but the
  cron runs at "06:00 UTC" — for a company with an AMC report at
  `2026-07-24 20:00 EDT`, the earliest the actual can hit is `2026-07-25
  ~00:00 UTC`, so today-06:00-UTC's cron catches it. Verify the boundary.
- **The AMC baseline** (DC7): baseline = **next** trading bar after the
  event date. If Yahoo hasn't published the +1 bar yet, baseline stays
  `null` and the whole reaction is `pending`. Handle explicitly — do not
  crash on null.
- **Restatement detection**: comparing the new actual against the persisted
  one — with what tolerance? A rounding rebase (`0.42` → `0.421`) shouldn't
  trigger a supersede. Use ≥ 0.5% delta as the threshold. Log every case.
- **Cron overrun**. If the cron takes > 60 s and Vercel Hobby-tier is in use,
  it may kill the job. Confirm tier (OQ9). Structure so each step logs
  progress and the job can be resumed on a partial completion.
- **The single-commit rule**. All state changes from one cron run collapse
  into one commit. If the job crashes mid-run, nothing partial is committed.

**Testing checkpoint W6.T1:**
1. Manually trigger the cron via `curl -H "Authorization: Bearer $CRON_SECRET"
   -X POST http://localhost:3000/api/cron/daily`. Response returns a per-step
   summary (prices refreshed, events touched, sources appended).
2. `data/earnings.json` shows updated `lastUpdated` + one new git commit.
3. A previously-pending horizon whose `populatesOn` is in the past now shows
   `status=matured` with an `absReturn` value.
4. Kill one vendor mid-run (block its URL at the network layer). Cron
   finishes with that engine `ok=false` in the affected events' `engineStatus`.
5. Run the cron twice back-to-back → no duplicate source items; commit
   count = 1 (the second run is a no-op).
6. `GET /api/health` returns fresh `snapshotAt` and populated `engines[]`.
7. Set `LLM_ENABLED=false` (DC8): source items land un-enriched, no
   Anthropic calls in logs.

**Ops readiness after W6:** the system runs itself. All later phases are
enhancements.

---

### W7 · Documents + hosted mode
**Goal:** clicking a Fact link opens the primary source at the exact paragraph.

Scope:
- Endpoint: `GET /api/documents/:id` returning
  `{ html, meta: DocumentMeta }`.
- Ingest-time HTML rendering: for company-posted press releases + EDGAR/SEDAR
  filings, backend fetches → sanitizes (DOMPurify equivalent server-side) →
  injects `<section id="para-N">` anchors → segments the transcript for
  speaker/section metadata.
- `sourceContentHash` on each Document; cron re-fetches within the source
  window and bumps `ingestVersion` on change (N2).
- Third-party items remain link-out only.

FE changes:
- `apiClient.getDocument(id)` flipped.
- `SourceViewer` hosted-mode replaces the mocked "Sample segment" with a
  real `dangerouslySetInnerHTML` render of the fetched HTML + auto-scroll
  to `#para-N` from `Fact.source.locator`.
- Anchor-not-found → falls back to top of doc + inline notice.
- Segment nav for transcripts (prepared / Q&A jump buttons).

**Data-transformation risks / debug areas:**
- **HTML sanitization edge cases.** Retain `<a>`, `<section>`, `<h1..h6>`,
  `<p>`, `<strong>`, `<em>`, tables. Strip `<script>`, `<iframe>`, `<form>`,
  event handlers, `javascript:` URLs.
- **CSP** for the hosted document render. FE loads sanitized HTML inline;
  Content Security Policy must permit `img-src` from the source's domain
  (transcripts sometimes embed logos).
- **Transcript segmentation** requires speaker attribution — regex-based on
  the reference. Different companies use different transcript formats
  (Motley Fool style vs Seeking Alpha style vs company-native). Ship
  parsers per format; fail soft to unsegmented body.
- **Anchor id collisions.** Two `<section id="para-1">` in different docs
  are fine; two inside the same doc are not. Rewrite anchors during
  sanitization if needed.
- **Content updates** (N2). `sourceContentHash` comparison catches updates;
  a bumped `ingestVersion` invalidates the CDN cache via ETag. FE viewer
  shows "Document updated <date>".

**Testing checkpoint W7.T1:**
1. Open a FactPopover on an Intel Q2 revenue Fact → click "View source" →
   slide-over opens hosted mode with paragraph 4 highlighted and scrolled
   into view.
2. Open a non-hosted source (Bloomberg opinion) → link-out confirmation
   modal → opens the publisher URL in a new tab.
3. Change the source HTML (edit the underlying file simulating an IR-page
   update) → next cron run bumps `ingestVersion` → FE refetches → the
   viewer shows the updated content.
4. Fact with a `locator` that doesn't exist in the doc → viewer shows
   fallback-to-top notice.
5. Sanitized HTML never triggers a CSP violation in the browser console.

---

### W8 · Backfill + cutover
**Goal:** replace fixtures with real history. Go live.

Scope:
- `scripts/backfill.mjs` (local, residential IP).
- ~3 years of daily bars per ticker (Q13 default; confirm with analyst).
- ~8 quarters of past events per operating/developer name, keyed on
  `(ticker, period)`.
- ETF distributions + holdings from ETF issuer pages (manual snapshot
  acceptable in v1; keeps FMP unnecessary).
- Populate `entity-registry.json` with real `xHandle`, `officialSources[]`
  per Appendix A.2–A.6.
- Final `FEATURE_FLAGS.liveMode = true` toggle removed (methods already
  live per-method by this point).
- Remove `lib/fixtures/*` files from imports outside `test/` (keep them for
  tests only).

FE changes:
- `apiClient.ts` — delete the throw-on-live branches. All methods are live.
- `providers/PersistenceProvider.tsx` — remove the "fixture mode" flag; only
  distinguishes Synced / Syncing / Local now.
- Header "fixture-mode" version tag in the footer → "v1.0".

**Data-transformation risks / debug areas:**
- **Backfill completeness**. For each of the 17 names, a coverage checklist:
  bars, official-sources registered, past 8Q events with actuals, ETFs with
  distributions + holdings. Anything missing → known-null with staleness
  flag, not fabricated.
- **First-day noise**. First cron run after backfill will attempt to mature
  every pending horizon, poll every current source window, and enrich
  nothing (LLM off). Log every step; expect a 3-4 min run, not 90 s.
- **CIO acceptance test**. Journey J6 (mobile read-only Overview + Detail).
  Confirm on a real phone.
- **Analyst acceptance test**. Journey J2 (investigate a print, verify from
  source in ≤ 2 min). Time it.

**Testing checkpoint W8.T1 (go/no-go):**
1. Backfill runs to completion locally, commits `data/earnings.json` (real
   data, no fixture ids).
2. Deploy to prod. Cron runs successfully at 06:00 UTC.
3. All six journeys from FE PRD §8 pass end-to-end on the live app:
   J1 morning scan, J2 investigate, J3 onboard new name, J4 manual entry,
   J5 add custom source, J6 CIO read-only.
4. `/api/health` green across all engines for two consecutive weekdays.
5. No `500`s in Vercel logs across a 48h window.
6. Coverage sanity: for each of the 17, at least one Fact on each headline
   metric with a working DeepLinkButton.

**If any step fails → do not cut over. Fix, retest, repeat.**

---

## 4 · Cross-phase testing infrastructure

Not phase-specific, but must exist by W2 at the latest:

- **Fixture-parity tests.** Every fixture is asserted against a Zod (or
  equivalent) schema derived from `Backend_PRD.md §3`. Same schema validates
  live responses. This catches shape drift **before** the FE sees it.
- **Vendor-response fixtures.** For each of I1–I11, a captured real response
  in `test/vendor-fixtures/`. Parsers tested against these — because vendor
  quirks are the whole reason the reference `_html.js`, `_feedFetcher.js`,
  etc. exist.
- **Commit-pipe integration test.** Uses a throwaway GitHub repo + a scoped
  PAT to exercise real 409/503 paths. Runs in CI on nightly.
- **Journey smoke tests.** Playwright (or similar) covering J1–J6, run
  headless on every push to `main`.

---

## 5 · Data-transformation "danger zones" — consolidated

Areas where the wire-up is most likely to require debugging or a bespoke
transformer. Ordered by expected pain:

1. **Vendor HTML/RSS quirks (W5).** EDGAR UA, Q4 403s, B3 POST-with-Origin,
   ABXX/SHLE HTML parsers. Cause of most reference-code lessons.
2. **Google News redirect resolution + article verifier (W5).** Concurrency
   + timeout tuning is empirical.
3. **`mentionsHolding` false positives (W5).** Every collision the reference
   registry knows about must be in ours.
4. **Reaction status + terminal states (W2).** FE was written assuming
   `null=pending`. Backend explicit `status` field forces an FE refactor.
5. **Fact.value type widening from `number` to `number|string` (W2).**
   Guidance-move text and expectation strings need handling.
6. **Entra groups claim overage (W0).** Users in >150 groups hit the Graph
   fallback path.
7. **Session cookie domain on preview vs prod URLs (W0).**
8. **409 storms on same-event verdict-note editing (W3).**
9. **Ticker-lookup name collisions (W4).** RIO PA → Rio Tinto, not "some
   other RIO".
10. **Registry write atomicity across concurrent editors (W4).**
11. **Restatement threshold (W6).** 0.5% is a guess; tune with real data.
12. **HTML sanitization + CSP for hosted docs (W7).**
13. **Timezone boundary on AMC → next-session baseline (W6).**

Anything in the top 5 is where 40% of the wire-up time will go.

---

## 6 · Timeline & sequencing recommendation

Rough estimate — one engineer, full-time.

| Phase | Wall time | Depends on |
|---|---|---|
| W0 | 3–5 days | OQ1/OQ2 resolved (BluOr IT) |
| W1 | 2 days | W0 |
| W2 | 3–4 days | W1 |
| W3 | 2–3 days | W2 + `GH_PAT` provisioned |
| W4 | 4–5 days | W3 |
| W5 | 6–8 days | W4 + Cloudflare Worker deployed |
| W6 | 3–4 days | W5 |
| W7 | 4–5 days | W6 (or in parallel) |
| W8 | 3–5 days | all previous |

**Total: ~5–7 weeks** to go-live. Parallelization is possible in W7 (hosted
docs) alongside W6 (cron).

Blockers that gate the whole plan: OQ1/OQ2 (Entra), `GH_PAT`, Cloudflare
Worker account, and analyst confirmation of Q13 backfill scope.

---
