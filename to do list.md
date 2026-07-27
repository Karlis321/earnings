# To Do — What's Left for a Full Working Dashboard

**Prod URL:** https://earnings-neon.vercel.app
**Portfolio:** 17 core tickers from `prompt1.txt` + 267 sector-universe = **284 entities**
**Last cron:** 2026-07-27T08:56Z (ok, 14.2s) → 260 events in `earnings.json`
**Market-cap coverage:** 282/284 have live USD caps · 2 remaining nulls are BP class-share oddities

---

## ✅ Done this cycle (UI/UX pass)

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

- [ ] **Press-release feeds unpopulated for new tickers.**
      `frontend/server/vendors/pressReleases.ts` needs entries for
      BOLSY, ABXX, TNZ, VLE, TOI, DBG, WRN, XEG, RIO FP. Until then,
      Refresh Sources falls back to news-only for those names.

- [ ] **Metric dictionary gaps.** Some portfolio tickers need
      sector-appropriate metrics not in the fixture:
  - TOI (software) → `arr_usd_m`, `net_dollar_retention_pct`
  - BOLSY (exchange) → `daily_volumes_usd_b`, `revenue_take_bps`
  - Add via `/admin` → new metric key, or edit
    `data/metric-dictionary.json` directly.

---

## Still open · code polish

- [ ] **Google News redirect resolution.** Item 5 on the original W5
      to-do. News items link to Google News redirect URLs, not directly
      to the publisher. Works, but one hop longer than ideal. Add an
      article-verifier pass in `server/vendors/news.ts` (concurrency 8,
      6s timeout).

- [ ] **`mentionsHolding` review.** Prod cron shows `totalAppended: 0`
      even when Google returns 800+ news items. Either the alias regex
      is too strict for the portfolio names or news genuinely didn't
      mention them in the 14-day window. Needs a controlled test with a
      known headline mentioning e.g. Brookfield to distinguish.

- [ ] **BP class-share cosmetic.** `BP-A.L` and `BP-B.L` are the only
      remaining `marketCapUsd: null` — Yahoo doesn't tag them with
      marketCap OR netAssets. Low priority (odd share classes rarely
      matter for coverage).

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

- [ ] Regenerate `frontend/lib/fixtures/registry.ts` from the same
      PORTFOLIO array in `rewrite-registry.mjs` so no-`GH_PAT` dev
      fallback + gallery stay in sync. Zero impact on prod.
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
