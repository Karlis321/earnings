# To Do — What's Left for a Full Working Dashboard

**Prod URL:** https://earnings-neon.vercel.app
**Portfolio:** 17 core tickers + 368 sector-universe (Argentine CEDEARs excluded) = **385 entities**
**Last local audit:** 2026-07-27
  · registry 385 entities · core 17 · universe 368 · 0 orphans
  · market caps populated: 355/385
  · EDGAR CIKs resolved: 73 · non-filers 312
  · events 256 · baselines seeded 143 · horizons matured 569
**Cron schedule:** Mon–Fri 06:00 UTC per `vercel.json`; next run 2026-07-28.
**Live upstream check (2026-07-27):**
  · EDGAR / Yahoo v8 chart / SEC company_tickers.json / Google News RSS
    all 200
  · All 5 remaining OFFICIAL_SOURCES IR RSS feeds 200
  · Two dead feeds removed (SilverCrest gone, Century URL fixed to WP)

---

## ✅ Done this cycle (audit + cleanup)

- [x] **Data-consistency audit.** Cross-referenced registry × earnings
      × fixtures × metric-dictionary × shared-state. Found 10 orphan
      events (5 AAPL US left over from the J4 smoke test + 5 CEDEAR
      entries `TGSU2 AF` / `YPFD AF` from the pre-filter era);
      trimmed. `earnings.json` now 256 events, all cross-referenced
      cleanly against the 385-entity registry.

- [x] **Live upstream source probe.** Curl'd every OFFICIAL_SOURCES
      RSS feed + Yahoo chart + SEC ticker JSON + Google News. Caught
      two dead feeds: `centuryaluminum.com/RSS/PressRelease.aspx`
      (403 — site migrated to WordPress; swapped in
      `/feed/`) and `silvercrestmetals.com/feed/` (000 DNS fail —
      SILV CN not in registry anyway; entry removed).

- [x] **OFFICIAL_SOURCES pruned.** Removed pure-EDGAR entries for
      tickers whose CIKs are now resolved by the auto-resolver
      (`INTC US`, `NVDA US`, `BN US`, `CCJ US`, `TGB CN`, `RIO PA`,
      `NOK FH`, `SHLE US`, `SILV CN`, `ABXX CN` placeholder).
      OFFICIAL_SOURCES now only holds entries that add VALUE beyond
      EDGAR — IR-page RSS or Newsfile IDs.

- [x] **`/api/documents/proxy` allowlist consolidated.** The proxy
      route had its own drifted allowlist that didn't match
      `INGESTABLE_HOSTS`. Now imports `INGESTABLE_HOSTS` from
      `documentIngest.ts` so widening one auto-widens the other.

- [x] **`lib/logos.ts` rewritten to match PORTFOLIO.** Was still
      referencing INTC, NVDA, RIO PA, SHLE US, NOK FH, COPX, URA,
      CCJ, SILV — none in the current registry. Also had `TGB CN`
      (renamed to `TGB US`). 17 domain mappings now match the
      fixture + data exactly (verified by set-diff).

- [x] **npm run typecheck / lint / build — blocked.** All three
      shell out via `next` / `tsc` which are AppLocker-blocked on
      this Windows Server 2019 host regardless of shell (Bash and
      PowerShell both refuse). Documented in the "Blocked" bucket
      below; nothing further from my seat.

---

## ✅ Done previous cycle (CEDEAR filter + universe re-expansion)

- [x] **Filtered Argentine CEDEARs from sector expansion.** Dropped
      `BUE: "AF"` from `YAHOO_TO_BB` in both `scripts/expand-sectors.mjs`
      and `frontend/server/lib/sectorExpansion.ts`. Argentine CEDEARs
      (AAPL.BA, NVDA.BA, TSM.BA, etc.) report Yahoo marketCaps
      disconnected from the underlying issuer (Apple showed $1.56T on
      BA vs $4.89T on Nasdaq). Stripped 57 existing AF entries from
      the registry and re-ran expansion at `size=100`. Registry landed
      at 385 entities (17 core + 368 universe) with `AF: 0`. Apple
      now appears via legitimate primaries — `AAPL MM` (MXN $4.90T),
      `AAPL34 BZ` (BRL $4.90T), `AAPL CN` ($4.89T) — all matching
      real cap on Nasdaq.

- [x] **Re-refreshed caps with live FX + re-backfilled CIKs** across
      the enlarged 385-entity registry. Live rates for 37/37
      currencies. Caps updated 114 · unchanged 241 · failed 30
      (withdrawn tickers). CIK backfill picked up 36 additional
      filers from the new listings (WPM LN, LIN1N MM, SOLBE1 SJ,
      etc.) for a total of 123 SEC filers across the registry.

- [x] **Universe market-cap refresh with live FX** via
      `scripts/refresh-market-caps.mjs`. Crumb-authed Yahoo v7 quote
      for every 282 symbols, live `<CCY>USD=X` for 37 currencies,
      convert + re-tier. Updated 82, unchanged 184, failed 16
      (missing/withdrawn symbols). Three tier moves — all `unknown →
      known` because the previous fallback FX was close to live. Also
      surfaced that `AAPL AF` (=AAPL.BA) is an Argentine CEDEAR whose
      Yahoo-reported market cap (2.34e15 ARS × 0.000668 = ~$1.56T) is
      genuinely disconnected from Apple's real $4.89T cap on Nasdaq.
      Flagged below as a future scope.

- [x] **EDGAR CIK backfill locally** via `scripts/backfill-edgar-cik.mjs`.
      Loads SEC's public ticker→CIK JSON, matches every registry entity
      (US: direct base-symbol; non-US: legal-name overlap + F-variant),
      writes `edgarCik` back. Result: 87 CIKs resolved / 195 non-filers
      correctly marked null across 282 entities. Caught a false-positive
      bug in the original resolver — `RIO FP` (Amundi Brazil ETF, Paris)
      was matching Rio Tinto's SEC CIK on base-symbol alone. Fixed both
      the .mjs and the server-side `edgarCikResolver.ts` to require
      legal-name overlap for non-US listings.

- [x] **Reaction baseline seeding locally** via
      `scripts/seed-reaction-baselines.mjs`. Seeds `reaction.points`
      into the 208 past events with `points: []`, then for each event
      with a past anchor and no baseline, picks the baseline bar
      (BMO/AMC rule) from Yahoo's 1yr chart and matures every horizon
      whose `populatesOn` is past. Result: 204 events seeded with
      points · 146 baselines seeded · 581 horizons matured (real
      abs + excess returns computed). Also added a
      `BASELINE_TOLERANCE_DAYS = 7` guard so events pre-dating the bar
      window don't grab bar[0] as a false baseline.

- [x] **IR-page RSS for three non-SEC tickers.** Probed IR pages for
      `<link rel=alternate type=application/rss+xml>` and verified:
      TOI CN → `https://topicus.com/rss` (WP-style RSS), DBG CN →
      `https://www.doubleview.ca/feed/` (WP feed), VLE CN →
      `https://www.valeuraenergy.com/feed/` (WP feed). Added all three
      to `OFFICIAL_SOURCES` in `pressReleases.ts`. TNZ CN
      (Squarespace-hosted) exposes no RSS. B3 (BOLSY US) has
      `ri.b3.com.br/feed/` advertised but body is empty. Skipped ETFs
      (XEG, RIO FP) — no earnings PRs by design.

---

## ✅ Done previous cycle (IR-page RSS + list cleanup)

- [x] **IR-page RSS for three non-SEC tickers.** Probed IR pages for
      `<link rel=alternate type=application/rss+xml>` and verified:
      TOI CN → `https://topicus.com/rss` (WP-style RSS), DBG CN →
      `https://www.doubleview.ca/feed/` (WP feed), VLE CN →
      `https://www.valeuraenergy.com/feed/` (WP feed). Added all three
      to `OFFICIAL_SOURCES` in `pressReleases.ts`. TNZ CN
      (Squarespace-hosted) exposes no RSS — verified via robots.txt +
      `/press-releases?format=rss` returning empty. B3 (BOLSY US) has
      `ri.b3.com.br/feed/` advertised but body is empty. Skipped ETFs
      (XEG, RIO FP) — no earnings PRs by design.

---

## ✅ Done previous cycle (admin coverage click-to-prefill)

- [x] **Click-to-prefill from coverage grid.** New client wrapper
      `AdminEntryPanel` lifts `(eventId, metric, slot)` selection state.
      Coverage grid cells (`actual` / `est` chips) are now buttons that
      emit `onSelect`; parent syncs `<ManualEntryForm selection={...}>`.
      Form's useEffect resets `eventId`, `metric`, `slot`, clears value,
      then focuses the value input on the next frame. Parent also
      smooth-scrolls the form into view. Source / as-of / method
      persist across cell clicks so a run of related entries doesn't
      wipe the paper trail.

---

## ✅ Done previous cycle (sector universe + admin coverage)

- [x] **Sector universe repopulated from Yahoo.**
      Registry went from 17 → 282 (17 core + 265 universe). Top 60 per
      sector by market cap: technology 52, materials 51, energy 51,
      ETFs 60, developer 51. Data file committed.

- [x] **`expand-sectors.mjs` FX conversion.** buildEntity was storing raw
      home-currency market caps in the `marketCapUsd` field, inflating
      KRW/IDR/ARS/JPY caps and pushing everything into the mega tier.
      Ported the `FX_FALLBACK` table + `<CCY>USD=X` live-rate fetch from
      `server/vendors/yahoo.ts`. Cap-tier distribution now reads
      23 mega / 70 large / 47 mid / 77 small / 48 unknown. Remaining
      edge cases (ARS-quoted AAPL AF, KRW Samsung) refine on the next
      cron pass with live FX.

- [x] **Sector view: equity / ETF split.** `sectorCounts()` now returns
      `{ id, count, portfolio, universe, equities, etfs }`. `/sectors`
      header stat line and per-card counts render all four splits.

- [x] **Admin entry coverage grid.** `/admin/entry/:ticker` now renders
      a compact grid above the manual-entry form: rows = events
      (past-first), columns = entity.headlineMetrics, cells show two
      slot chips (`actual` / `est`). Green ✓ = filled, dashed ± = empty.
      Totals in the header — "Actual: X/N · Estimate: Y/N". Makes
      empty rows discoverable at a glance so the user knows where the
      manual entry form should point next.

- [x] **Watchlist header overlap already fixed.** Symptom in prompt1.txt
      was resolved earlier in commit `a3df038` (`isolation:isolate` +
      z-20 + inline `bg: var(--panel2)` on the sticky header). Any
      stale screenshot showing the overlap is from a pre-`a3df038`
      cached build — hard-refresh clears it.

---

## ✅ Done previous cycle (coverage + reaction baseline)

- [x] **Per-entity Google News search.**
      Added `fetchEntityNews(ticker, tokens, days)` in
      `frontend/server/vendors/news.ts` — builds a single Google News
      RSS URL from `tickerSearchTokens(entity)` (quoted phrases, OR'd,
      `+when:14d`), fetches once per unique ticker, applies the same
      time-cutoff + redirect resolution as the shared pool. Verified
      live against Hudbay's Google News URL (returns 8 real headlines).
      Wired into cron as an additional per-ticker news source alongside
      the shared theme pool; cached per unique ticker like press
      releases. `perEventStatus.google.ok` now OR's the entity-search
      result with the shared pool.

- [x] **Reaction baseline seeding — root cause + fix.**
      `matureEventReaction` returned early on every event because
      `event.reaction.baselineDate` was `null` — the comment on
      `buildEventShell` promised "a future cron run seeds them" but
      nothing did. Folded baseline seeding into `matureEventReaction`:
      when the event date has passed and no baseline exists, seed it
      from the security's own bars using the BMO/AMC rule
      (`pickBaselineIdx`), then continue with horizon maturation in the
      same call (reuses the same 3mo bar fetch). Also fixed a related
      bug: 208 past events were persisted with `reaction.points: []`.
      Added `seedReactionPoints` (called before `matureEventReaction`
      in cron) to fill in the four HORIZONS for events that lack them,
      and `buildPastEvent` now seeds them at creation time. The cron's
      write-back gate now also triggers on reaction-only changes so
      seeded baselines get persisted even when no horizon matures.

- [x] **Chart hover-dot horizontal offset — root cause + fix.**
      Symptom "zero at center, grows toward both edges". The
      `clientX -> viewBox` scale factor was correct (has been since
      commit `400c5de`). The real cause: SVG had default
      `preserveAspectRatio="xMidYMid meet"` which letterboxes the
      900-wide viewBox inside a wider container — `rect.width` includes
      the dead space so the mapping is off by the letterbox offset.
      Set `preserveAspectRatio="none"`. Vertical is unaffected because
      `height` matches viewBox height.

---

## ✅ Done previous cycle (perf + correctness)

- [x] **Cron news fan-out — hoisted out of the per-event loop.**
      Previously `fanoutNews({ query: entity.displayName, days: 14 })` ran
      inside the 260-event loop → ~14k RSS fetches per cron run. Now
      called once with no query at the top of the run; press releases
      cached per unique ticker via a `Map<ticker, PressReleasesResult>`.
      Per-run engine aggregation collapsed to a single pass. Expect the
      cron runtime to drop from double-digit seconds to a few seconds.

- [x] **`mentionsHolding` zero-append — root cause + fix.**
      Diagnosed via `scripts/test-mentions-holding.mjs`: the old
      `.includes(displayName)` pre-filter dropped 4/6 headlines that
      `mentionsHolding` correctly matches (e.g. "Hudbay reports Q3" was
      cut because it didn't contain the full "Hudbay Minerals"). The
      hoisted `fanoutNews` call passes no query, letting `mentionsHolding`
      apply the only entity filter downstream. Expect `totalAppended` to
      go from 0 to non-trivial on the next cron.

- [x] **Fixture orphans cleaned.**
      Dropped `intelQ2` + `nvdaQ1` events from `fixtures/earnings.ts`
      (their headline metrics like `data_center_rev_usd_m` don't apply
      to any current registry ticker). `fixtures/etf.ts` replaced
      `COPX US` + `URA US` with `XEG CN` + `RIO FP` matching the
      registry. `fixtures/sharedState.ts` custom-sources retargeted from
      `INTC US`/`NVDA US` to `CS CN`/`HBM US`; themes list refreshed.
      No-`GH_PAT` dev fallback + gallery now match the current portfolio.

---

## ✅ Done previous cycle (automation + polish)

- [x] **Press-release feeds — now auto-populated for new tickers.**
      Added `frontend/server/lib/edgarCikResolver.ts` — module-cached
      (24h TTL) load of SEC's public `company_tickers.json` mapping every
      SEC filer's ticker → CIK, including 20-F/40-F foreign filers.
      Wired into `POST /api/entity-registry` so `edgarCik` is resolved at
      add-ticker time; `Entity.edgarCik?` added to `frontend/lib/types.ts`
      (`null` = confirmed not an SEC filer, `undefined` = not yet checked).
      `fetchPressReleases()` merges a synthesized EDGAR feed from the
      registry entity's CIK when the hand-curated `OFFICIAL_SOURCES` map
      has no entry. Cron step 6c backfills missing CIKs for existing
      entities alongside the market-cap refresh (single commit).
      Impact: adding e.g. AAPL now auto-hits EDGAR without editing
      `pressReleases.ts`. Hand-curated IR-page RSS entries remain the way
      to add non-SEC feeds (Newsfile / IR-page RSS URLs aren't
      discoverable programmatically).

- [x] **Metric-dictionary gaps closed.**
      Added `arr_usd_m`, `net_dollar_retention_pct` (TOI/software) and
      `daily_volumes_usd_b`, `revenue_take_bps` (BOLSY/exchange) to
      `data/metric-dictionary.json`. Fixture `METRIC_LABELS` also updated.

- [x] **Google News redirect resolution.**
      `fanoutNews()` now resolves `news.google.com/rss/articles/...`
      URLs to the publisher URL (HEAD-first, GET fallback, concurrency 8,
      6s timeout, fail-soft). Runs before dedup so two gnews URLs for the
      same Reuters article collapse to one. Reports `redirectsResolved`
      in the result payload.

- [x] **fixtures/registry.ts regenerated from PORTFOLIO.**
      `frontend/lib/fixtures/registry.ts` now mirrors the PORTFOLIO array
      in `scripts/rewrite-registry.mjs` (17 tickers, exact aliases + Yahoo
      symbols). No-GH_PAT dev fallback + gallery now match prod. Fixture
      `METRIC_LABELS` extended with the new TOI/BOLSY metric keys.

---

## ✅ Done prior cycle (UI/UX pass)

- [x] **/sectors auto-updating counts** — `sectorCounts()` now returns
      `{ id, count, portfolio, universe }` per tag. Page shows total /
      portfolio / universe counts in the header and per card. RSC is
      `force-dynamic` and the store carries a 60s read cache — counts
      stay live within a minute of any registry write (POST entity,
      DELETE, cron sector expansion).

- [x] **Home page floods** — was showing all 284 entities on the
      "portfolio" tab. Now filters `isCore` by default (17 rows) with a
      subline count "+ 267 sector-universe names — switch tabs below".

- [x] **SecuritySwitcher dropdown flood** — 284-entity dropdown was
      unusable. Capped to isCore (17); if a non-core ticker is the
      current page, that entry gets pinned at top.

- [x] **Admin coverage split** — "Portfolio · 17 · isCore" always
      visible with capTier chips; "Sector universe · 267 · not on core"
      collapsed `<details>` in a 3-col dense grid.

- [x] **Sector detail split** — pages like /sectors/materials had 108
      rows in a flat list. Now portfolio panel always visible, universe
      panel collapsed (`<details>`, sorted by market cap desc).

- [x] **OperatingDetail split** — was showing "Latest print · FY2026 Q2"
      with all-empty metric rows when the primary event was upcoming.
      Now splits into "Next reporting · <period>" panel + "Latest print
      · <period>" card. Guidance / Reaction / Sources key off `primary`
      (past-preferred).

- [x] **ReactionChart empty state** — past events land with `points:[]`
      (no baseline). Was rendering an empty grid. Now shows a dashed
      card "Reaction not tracked for this event. Baseline close wasn't
      captured at report time — future events auto-populate on the
      daily cron."

- [x] **Past-event EPS matching** — regex was `/^eps/i`, missing keys
      like `dr_eps_usd`. Now matches `/eps/i` and injects a standalone
      `eps_usd` metric when no eps-like headline metric exists. Re-ran
      backfill; portfolio operating tickers now show real EPS + surprise
      pcts across 4 past quarters.

- [x] **Price bulk failures** — `yahooLookup` filtered to EQUITY only,
      breaking ETFs (GDXJ, XEG, RIO FP). Widened to EQUITY | ETF |
      MUTUALFUND. `/api/prices/bulk` now also prefers registry-persisted
      `yahooSymbol` first — 4/8 → 7/8 tickers resolving cleanly. Last
      failing ticker (ABXX) is a recent NEO listing with thin history;
      relaxed the "no series" threshold from 2 → 1 bar so the endpoint
      returns the single available price.

---

## ✅ Done previous cycle

- [x] **Vercel prod deploy + env vars** — live at
      `earnings-neon.vercel.app`. `GH_PAT`, `GH_REPO_OWNER`, `GH_REPO_NAME`,
      `GH_BRANCH`, `CRON_SECRET` all set on production. `/api/health`
      returns `mode: git-snapshot`, `ghPatPresent: true`.

- [x] **Manual cron primed** — three successful runs verified. Latest:
      284 attempted / 86 updated / 196 unchanged / 2 failed / 3 tier
      changes. `newEvents: 213` on sector-universe expansion pass.

- [x] **Cron marketCap FX conversion** — `server/vendors/yahoo.ts`
      exposes `getFxRates()` + `toUsd()` with a 15-min cache; live rates
      via Yahoo's `<CCY>USD=X`. FX map now covers **33 currencies**
      (Asia-Pac, Middle East, LatAm, Europe non-euro). Failed count
      dropped from 65 → 2.

- [x] **ETF marketCap fallback** — `yahooQuoteMetaBatchRaw` now falls
      back to `netAssets` / `totalAssets` for ETF quotes; the 60-ETF
      sector-universe slice now has real AUM values and correct caps.

- [x] **Persist `yahooSymbol` on Entity** — cron + backfill + POST entity
      all prefer the stored symbol over `yahooLookup` search. Fixes
      VLE CN ($46M → $939M) and RIO FP ($148B → correct null / ETF).

- [x] **Past-earnings backfill** — Yahoo `earningsChart.quarterly`
      exposed via `YahooEarnings.pastQuarters`; cron step 3a.5 upserts
      any missing past quarters with actual EPS + surprise pct. Registry
      went from 47 → 260 events after the first cron pass.

- [x] **Add-ticker auto-backfill** — `POST /api/entity-registry` now
      resolves Yahoo symbol → snapshots market cap → inserts past 4Q +
      upcoming events in a single `mutateEarnings` commit. New tickers
      land ready to render.

- [x] **Sector-wide expansion** — 284 entities across 5 sectors
      (technology 52, materials 51, energy 51, etfs 60, developer 53).
      Global regions; unmapped exchanges skip cleanly instead of
      defaulting to `US`.

- [x] **Tier distribution rebalanced** — mega 31, large 78, mid 53,
      small 85, unknown 37. Down from 141 (bogus) mega before FX
      conversion.

---

## Waiting on next scheduled cron (2026-07-28 06:00 UTC)

Local runners have already done the CIK backfill + baseline seeding;
these two items now just need to survive one prod cron run to confirm
the server-side implementations match.

- [ ] **Verify server-side EDGAR CIK backfill.** Local runner filled
      87 CIKs across 282 entities. Prod cron step 6c should produce
      the same result (same SEC file, same resolver logic post-fix).

- [ ] **Verify server-side reaction baseline seeding.** Local runner
      populated 146 baselines + 581 matured horizons. Prod cron's
      `matureEventReaction` should produce the same result — note the
      prod code uses `range=3mo` (narrower than the 1yr window the
      script used) so it'll only cover events within the last quarter
      going forward. Events older than 3mo will retain the baselines
      the local runner just wrote.

- [ ] **Document ingest.** Allowlist widened to include wire services
      (GlobeNewswire, PR Newswire, Newswire.ca, BusinessWire,
      Accesswire) + Yahoo Finance. Expect `data/documents/<id>.json`
      files to appear after the next cron pass.

- [ ] **Document ingest.** Allowlist widened last cycle to include wire
      services (GlobeNewswire, PR Newswire, Newswire.ca, BusinessWire,
      Accesswire) + Yahoo Finance. Expect `data/documents/<id>.json`
      files to appear after the next cron pass. Not run locally
      because the sanitize + paragraph-anchor + transcript-segment
      pipeline is ~300 lines of TS with Next.js path aliases —
      reimplementing in .mjs is not a good trade when cron fires
      tomorrow.

---

## Blocked · needs a real host or browser

- [ ] **Typecheck.** `npm run typecheck` is blocked by group policy
      on this box (Windows Server 2019 lockdown). Re-run on a
      developer machine to confirm all changes since `edgarCikResolver`
      landed still typecheck clean. Nothing to fix in code — this is a
      host-permission issue.

- [ ] **J2 smoke test — FactPopover → View source → hosted mode.**
      Open `/s/HBM%20US/e/<past-event-id>` in a browser, click a
      metric cell → "View source"; confirm slide-over opens with the
      source URL loaded via iframe (Yahoo URLs = iframe mode) or
      hosted-mode after document ingest has processed one press
      release. Requires a browser — can't be curl'd.

---

## Won't fix (or explicitly deferred)

- [ ] **BP class-share cosmetic.** `BP-A LN` / `BP-B LN` came into the
      universe via sector expansion. Yahoo returns no `marketCap` or
      `netAssets` for these class shares, so `marketCapUsd` stays
      `null`. Won't fix — class-share odd-lots aren't worth a special
      code path.

- [ ] **LLM extractor for headline-metric Facts.** Coverage grid +
      click-to-prefill make manual entry fast. Automating extraction
      would require pulling ingested document text through an LLM;
      deferred behind the $0 no-LLM mode gate.

- [ ] **LLM expansion path** (`prompt1.txt` template as a
      Claude+web-search prompt). Yahoo screener at `/admin/expand`
      already covers the same use case at $0.

---

## Journey smoke tests · walked via API + DOM curl on prod

Verified against `https://earnings-neon.vercel.app` — six pass end-to-end,
one partial (needs a real browser for the click flow).

- [x] **J1** Home → security → event · **PASS**
      - Home 200, HBM row present, deep link renders
      - Security 200 with h1 + Next reporting / Latest print / Past Quarters panels + 5 event links
      - Event 200 with correct FY202X QX h1
- [x] **J3** Refresh sources fan-out · **PASS**
      - `/api/news` 32 engines returned · `/api/press-releases` 10 items
        (2 engines) · `/api/tweets` 0 items ok:false (no
        TWITTERAPI_IO_KEY set — correct)
      - `POST /api/events/[id]/append-sources` returns `{ok:true, appended:N}`
- [x] **J4** Add security + auto-backfill · **PASS**
      - POST AAPL US → HTTP 200, yahooSymbol=AAPL, marketCap $4.89T,
        capTier=mega, **pastAdded:4 + upcomingAdded:1** in the same
        commit that added the entity
      - Verified via `/api/entity-registry` and
        `/api/earnings?ticker=AAPL%20US` (5 events)
      - DELETE cleanup 200
- [x] **J5** Manual entry · **PASS**
      - POST manual entry for BN US · estimate 135.5 landed with
        source label "Consensus", visible on the event via
        `/api/earnings?event=<id>`
      - Missing sourceUrl → HTTP 400 with `fields.sourceUrl` error
        (form validation contract holds)
- [x] **J6** Discover source · **PASS**
      - Substack URL → `site-filter` fallback
      - WSJ URL → major-news `site-filter`
      - X handle → `twitter` with @handle title
      - `/api/shared-state` returns 17 watchlist · 0 custom · 4 themes
- [x] **J7** Sector expansion · **PASS**
      - Technology large 8: 8 hits from 211-universe (STX, SAP, APH,
        CRWD, etc. — real Yahoo names + market caps)
      - Materials any 5, Developer small 5, ETFs any 5 all HTTP 200
      - Bad sector `nonsense` → 400 (validation)

- [~] **J2** Metric → FactPopover → View source → hosted mode · **PARTIAL**
      - Event page has FactPopover triggers in DOM (cursor-help spans
        around metric rows)
      - `/api/documents/[id]` returns 404 for un-ingested URLs → viewer
        correctly falls back to iframe / link-out per code path
      - Full mouseover + slide-over animation + auto-scroll-to-`#para-N`
        needs a browser to verify visually
      - **Todo**: open `/s/HBM%20US/e/<past-event-id>` in a browser,
        click a metric cell → "View source"; confirm slide-over opens
        with source URL loaded via iframe (Yahoo URLs = iframe mode;
        would go hosted-mode for `/api/documents/ingest`-processed URLs)

---

## Ongoing verification · post-launch

- [ ] `/api/health` green two consecutive weekdays
- [ ] No 500s in Vercel logs over 48h
- [ ] Every operating ticker has a Fact on each headline metric with a
      working DeepLinkButton (currently gated on manual entry — the
      coverage grid at `/admin/entry/:ticker` makes it fast)

---

## What's already shipped

Weeks W1–W8 landed. Highlights:

- **Store:** git-snapshot commit-pipe, 60s read cache, crumb-authed
  Yahoo, full CRUD via `/api/entity-registry`, `/api/manual-entry`,
  `/api/shared-state`, `/api/metric-dictionary`, `/api/discover-feed`,
  `/api/events/[id]/append-sources`, `/api/expand-watchlist`
- **Cron:** single-commit sources fan-out + reaction maturation +
  next-event upsert + restatement detection + past-quarter backfill +
  document auto-ingest + market-cap refresh (FX-converted, ETF
  netAssets fallback) + cron-status write
- **Documents:** sanitize → paragraph anchors → transcript segmentation
  → hosted-mode viewer with locator highlight + segment jump nav
- **Portfolio + universe:** 17 core + 267 sector-universe = 284 entities;
  every entity carries `yahooSymbol` for stable lookups
- **UI:** Watchlist with cap-tier filter chips, Settings › Data Status
  with engines / documents / restatements / new events, stale-refresh
  banner, hosted-mode Source Viewer, `/admin/expand` screener
