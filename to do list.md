# To Do — What's Left for a Full Working Dashboard

Portfolio is set (17 tickers from `prompt1.txt`), all code phases W1–W8 have
landed. The gaps below are what stands between "code compiles" and
"dashboard renders live data every weekday morning".

---

## Blockers · do these to have a working dashboard today

- [x] ~~Re-run backfill against the new registry~~ ✓ Done. 8 event shells
      seeded (BN, CENX, CS, HBM, TGB, TNZ, TOI, VLE). ABXX / BOLSY / SHLE
      returned no `nextEarningsDate` from Yahoo — expected for small-caps
      + ADRs; those events populate as they're announced. Backfill script
      rewritten to read from `data/entity-registry.json` (source of truth)
      instead of the stale fixture, and to only write `earnings.json` —
      registry / dictionary / shared-state stay under
      `scripts/rewrite-registry.mjs` control.

- [ ] **Vercel prod deploy + env vars.** Point Vercel at the repo (root =
      `frontend/`) and set:
  - `GH_PAT` — fine-grained token, `Contents: Read & Write` on this repo
  - `GH_REPO_OWNER` / `GH_REPO_NAME` / `GH_BRANCH=main`
  - `CRON_SECRET` — random string; Vercel Cron sends it as the Bearer token
  - `TWITTERAPI_IO_KEY` — optional; only if you want X mentions
  - `ANTHROPIC_API_KEY` — optional; LLM enrichment stays off in `$0` mode

- [ ] **Manual cron trigger to prime everything.** After deploy:
  ```
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
       https://<vercel-url>/api/cron/daily
  ```
  Response should show non-zero `totalAppended` / `totalMatured` /
  `documents.attempted`. `/api/health` afterwards should list populated
  `engines[]` + a recent `lastCronRun`.

---

## Known code gaps · works today but not ideal

- [x] ~~Cron marketCap currency bug~~ ✓ Fixed. `server/vendors/yahoo.ts`
      now exposes `getFxRates()` + `toUsd()`; FX pairs come from Yahoo
      itself (`CADUSD=X`, `EURUSD=X`, `BRLUSD=X`, …) with a hardcoded
      fallback map, cached 15 min per process. `YahooQuoteRow` carries
      both `marketCap` (home ccy) and `marketCapUsd` (converted). Cron
      step 6 and `/api/expand-watchlist` both use the USD field so
      `capTier` boundaries hold across listings.

- [ ] **Press-release feeds unpopulated for new tickers.**
      `frontend/server/vendors/pressReleases.ts` needs entries for: BOLSY,
      ABXX, TNZ, VLE, TOI, DBG, WRN, XEG, RIO FP. Until then, Refresh
      Sources falls back to news-only for those names.

- [ ] **Google News redirect resolution never wired.** Item 5 on the
      original W5 to-do. News items link to Google News redirect URLs, not
      directly to the publisher. Works, but the link chain is one hop
      longer than it should be. Add an article-verifier pass in
      `server/vendors/news.ts` (concurrency 8, 6s timeout, per the
      reference impl).

- [ ] **Metric dictionary gaps.** Some new tickers need sector-appropriate
      metrics not in the fixture:
  - TOI (software) → `arr_usd_m`, `net_dollar_retention_pct`
  - BOLSY (exchange) → `daily_volumes_usd_b`, `revenue_take_bps`
  - Add via `/admin` → new metric key, or edit `data/metric-dictionary.json`.

---

## Journey smoke tests · 5-min end-to-end walkthrough

- [ ] **J1** Home → watchlist row click → security detail → event detail
- [ ] **J2** Event → click a metric → FactPopover → "View source" → hosted
      mode with correct paragraph highlighted
- [ ] **J3** Event → "Refresh sources" → per-engine chips flash → items
      appended → success toast shows count
- [ ] **J4** `/admin/securities/new` → fill form → Save → land back on
      `/admin` with new entity visible
- [ ] **J5** `/admin/entry/BN US` → pick event + metric + slot + value +
      source URL + as-of → Save → figure appears on the event detail
- [ ] **J6** `/admin/sources` → paste a Substack URL → Discover → set
      scope → Save → source appears in list; toggle off works

None of J1–J6 has been walked end-to-end from a real browser this session.
Every individual piece typechecks; composition still needs eyes.

---

## Post-launch verification · after the first cron run

- [ ] `/api/health` green two consecutive weekdays
- [ ] No 500s in Vercel logs over 48h
- [ ] Every operating ticker has a Fact on each headline metric with a
      working DeepLinkButton
- [ ] Reaction horizons matured for at least one past event (needs an
      event whose `populatesOn` ≤ today to trigger)
- [ ] Document ingest wrote at least one `data/documents/<id>.json`
      (needs a press-release URL on the allowlist — SEC/IR pages)

---

## Nice-to-have

- [ ] Regenerate `frontend/lib/fixtures/registry.ts` from the same
      PORTFOLIO array in `rewrite-registry.mjs` so no-GH_PAT dev fallback
      + gallery stay in sync. Zero impact on prod (git-snapshot store
      wins there); purely for local dev parity.
- [ ] LLM expansion path (`prompt1.txt` template as a Claude+web-search
      prompt). The Yahoo screener at `/admin/expand` already covers the
      same use case at `$0`. Wire the LLM path only if you want a
      commentary layer or non-Yahoo-covered names.
- [ ] Sector-wide expansion (250 tickers). Mechanism is built
      (`scripts/expand-sectors.mjs` + `POST /api/expand-watchlist` +
      `/admin/expand` UI). Currently unused because portfolio is
      restricted to 17.

---

## What's already shipped

Weeks W1–W8 landed. Highlights:

- Store: git-snapshot commit-pipe with 60s read cache, crumb-authed Yahoo,
  full CRUD via `/api/entity-registry`, `/api/manual-entry`,
  `/api/shared-state`, `/api/metric-dictionary`, `/api/discover-feed`,
  `/api/events/[id]/append-sources`, `/api/expand-watchlist`
- Cron: single-commit sources fan-out + reaction maturation + next-event
  upsert + restatement detection + document auto-ingest + market-cap
  refresh + cron-status write
- Documents: sanitize → paragraph anchors → transcript segmentation →
  hosted-mode viewer with locator highlight + segment jump nav
- Portfolio: 17 tickers from `prompt1.txt` seeded with real Yahoo market
  caps into `data/entity-registry.json`
- UI: Watchlist with cap-tier filter chips, Settings › Data status with
  engines / documents / restatements / new events, stale-refresh banner,
  hosted-mode Source Viewer, /admin/expand screener
