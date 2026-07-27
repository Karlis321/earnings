# To Do — What's Left for a Full Working Dashboard

**Prod URL:** https://earnings-neon.vercel.app
**Portfolio:** 17 core tickers from `prompt1.txt` + 267 sector-universe = **284 entities**
**Last cron:** 2026-07-27T08:56Z (ok, 14.2s) → 260 events in `earnings.json`
**Market-cap coverage:** 282/284 have live USD caps · 2 remaining nulls are BP class-share oddities

---

## ✅ Done this cycle

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

## Journey smoke tests · 5-min end-to-end walkthrough

- [ ] **J1** Home → watchlist row click → security detail → event detail
- [ ] **J2** Event → click a metric → FactPopover → "View source" →
      hosted mode with correct paragraph highlighted
- [ ] **J3** Event → "Refresh sources" → per-engine chips flash → items
      appended → success toast shows count
- [ ] **J4** `/admin/securities/new` → fill form → Save → land back on
      `/admin` with new entity visible; past + upcoming events auto-seed
- [ ] **J5** `/admin/entry/BN US` → pick event + metric + slot + value +
      source URL + as-of → Save → figure appears on the event detail
- [ ] **J6** `/admin/sources` → paste a Substack URL → Discover → set
      scope → Save → source appears in list; toggle off works
- [ ] **J7** `/admin/expand` → pick sector + tier → Discover → per-row
      Add → new entity lands with cap + past events

None of J1–J7 has been walked end-to-end from a real browser this
session. Every piece typechecks and prod is live; composition still
needs eyes.

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
