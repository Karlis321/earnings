# To Do — What's Left for a Full Working Dashboard

**Prod URL:** https://earnings-neon.vercel.app
**Portfolio:** 17 core tickers from `prompt1.txt` + 267 sector-universe = **284 entities**
**Last cron:** 2026-07-27T08:56Z (ok, 14.2s) → 260 events in `earnings.json`
**Market-cap coverage:** 282/284 have live USD caps · 2 remaining nulls are BP class-share oddities

---

## ✅ Done this cycle (perf + correctness)

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

## Still open · data-population

- [ ] **Verify EDGAR CIK backfill after next cron run.**
      Once cron step 6c runs against prod, every operating/developer
      ticker that files with SEC (WRN, ABXX-via-ABXXF, CENX, HBM, CS,
      CCJ, BN, TGB, SILV, RIO, NOK, …) should have `edgarCik` populated.
      Tickers that don't file with SEC (BOLSY, TOI, TNZ, VLE, DBG, XEG,
      RIO FP) will have `edgarCik: null` and stay on news-only for
      press releases unless a hand-curated IR-page RSS is added to
      `OFFICIAL_SOURCES` in `frontend/server/vendors/pressReleases.ts`.

- [ ] **Optional: hand-curated IR-page RSS for the non-SEC names.**
      For BOLSY, TOI, TNZ, VLE, DBG, XEG, RIO FP — IR-page RSS URLs
      aren't discoverable programmatically. Add real URLs to
      `OFFICIAL_SOURCES` after visiting each IR site. Low priority
      (news vendor covers headline flow).

---

## Still open · code polish

- [ ] **Typecheck locally.** `npm run typecheck` is blocked by group
      policy on this box; re-run locally to confirm the CIK resolver +
      redirect resolver changes typecheck clean. Files touched:
      `frontend/lib/types.ts`, `frontend/server/lib/edgarCikResolver.ts`,
      `frontend/app/api/entity-registry/route.ts`,
      `frontend/app/api/cron/daily/route.ts`,
      `frontend/server/vendors/pressReleases.ts`,
      `frontend/server/vendors/news.ts`,
      `frontend/lib/fixtures/registry.ts`,
      `data/metric-dictionary.json`.

- [ ] **BP class-share cosmetic.** `BP-A.L` and `BP-B.L` are the only
      remaining `marketCapUsd: null` — Yahoo doesn't tag them with
      marketCap OR netAssets. Low priority (odd share classes rarely
      matter for coverage).

- [ ] **Optional: per-entity Google News search.** With the news
      fan-out hoisted, we now share one 100-item news pool across all
      events. That is enough for the core 17 but caps per-entity
      coverage. If we want deeper per-entity coverage, add a targeted
      Google News RSS query per entity (e.g. `q=<displayName>+OR+<cashtag>+when:14d`)
      alongside the shared pool. Keep the shared pool for theme coverage.

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

## Post-launch verification · after Vercel's first scheduled cron

- [ ] `/api/health` green two consecutive weekdays (auto-cron fires
      Mon–Fri 06:00 UTC per `vercel.json`)
- [ ] No 500s in Vercel logs over 48h
- [ ] Every operating ticker has a Fact on each headline metric with a
      working DeepLinkButton
- [ ] Reaction horizons matured for at least one past event (needs an
      event whose `populatesOn` ≤ today)
- [ ] Document ingest wrote at least one `data/documents/<id>.json`
      (needs a press-release URL on the allowlist)

---

## Nice-to-have

- [ ] LLM expansion path (`prompt1.txt` template as a Claude+web-search
      prompt). Yahoo screener at `/admin/expand` already covers the same
      use case at `$0`. Wire the LLM path only if you want commentary or
      non-Yahoo-covered names.

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
