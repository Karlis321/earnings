# technical.md

## 1. STACK
- Next.js **15.5.21**, React **19.0.0**, TypeScript **^5.7.3** (`frontend/package.json`).
- App Router (`frontend/app/`, no `pages/`). No `getStaticProps` / ISR — every RSC page declares `export const dynamic = "force-dynamic"` (**dynamic SSR**). Interactive components use `"use client"`.
- Hosting: Vercel. `frontend/vercel.json` defines cron `/api/cron/daily` at `0 6 * * 1-5` UTC and per-route `maxDuration` (cron 300s, news 60s, tweets 30s, documents 15s).

## 2. DATA FLOW
- **News** — `frontend/server/vendors/news.ts::fanoutNews` (55 RSS sources) + `fetchEntityNews` (per-ticker Google-News OR-query). Cron + `/api/news`. Stored on `event.sources.items` in `data/earnings.json`.
- **Press releases** — `frontend/server/vendors/pressReleases.ts::fetchPressReleases` (EDGAR + IR RSS + Newsfile). Cron + `/api/press-releases`. Stored on `event.sources.items`; ingestable URLs also written to `data/documents/<id>.json`.
- **Prices** — `frontend/server/vendors/yahoo.ts::yahooSeries` (Yahoo v8 chart, no auth). Live per request via `/api/prices` and `/api/prices/bulk`. **Not stored.**
- **Earnings + fundamentals** — `yahooEarnings` (Yahoo v10 quoteSummary, crumb-authed modules `earnings,calendarEvents,financialData,defaultKeyStatistics`). Cron + `POST /api/entity-registry`. Past events in `data/earnings.json`; TTM in `entity.fundamentals`.
- **SEC XBRL** — `data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json`. Offline via `scripts/backfill-sec-metrics.mjs` and `scripts/backfill-sec-events.mjs`. Merged into `data/earnings.json`.
- **Tweets** — optional TwitterAPI.io via `frontend/server/vendors/tweets.ts`.
- **Market data** — `frontend/server/vendors/marketData.ts` live per request.
- **Persistence** — `frontend/server/store.ts` selects `gitSnapshotStore` (GitHub Contents API PUT for writes; inline for <1 MB reads, `download_url` for larger) when GH env set, else `inMemoryStore` (fixture-backed).

## 3. EARNINGS FETCH
```ts
export async function yahooEarnings(yahooSymbol: string): Promise<YahooEarnings | null> {
  const j = await fetchQuoteSummary(yahooSymbol);
  if (!j) return null;
  const result = j.quoteSummary?.result?.[0];
  if (!result) return null;
  const dates = result.calendarEvents?.earnings?.earningsDate ?? [];
  const quarterlyRaw = result.earnings?.earningsChart?.quarterly ?? [];
  const financialsRaw = result.earnings?.financialsChart?.quarterly ?? [];
  // maps into { period, actual, estimate, surprisePct, revenue, netIncome }
  return { yahooSymbol, nextEarningsDate, lastQuarter, pastQuarters,
           currentQuarterEstimate, ttm };
}
```
**State:** works for ~85 US 10-Q filers with full per-quarter data; returns 0 quarters for many foreign wrappers and 40-F / 20-F filers. Coverage today: 722/1639 (44%) universe-operating tickers have past events; 46/1639 (3%) have a next-event date. No visible error — Yahoo returns empty arrays.

## 4. PERSISTENCE
`data/` (committed):
- `entity-registry.json` — 2,277,730 bytes · 1867 entities
- `earnings.json` — 10,230,125 bytes · 2578 events
- `cron-status.json` — 42,606 bytes
- `metric-dictionary.json` — 3547 bytes
- `shared-state.json` — 720 bytes
- `coverage-audit.csv` — audit output
- `documents/` — 8 sanitized press-release JSON files

`frontend/lib/fixtures/` — 4 TS files used when `GH_PAT` absent.

## 5. SCALE FACTS
- **Tickers: 1867** (17 core + 1850 universe) in `data/entity-registry.json`.
- **Events: 2578**.
- Repo (excl. `node_modules`, `.git`, `.next`): **18 MB**.
- Build time: **cannot determine** — no recent successful `next build` log; local build blocked by group policy.

## 6. SECRETS & AUTH
From `frontend/.env.example`: `GH_PAT`, `GH_REPO_OWNER`, `GH_REPO_NAME`, `GH_BRANCH`, `CRON_SECRET`, `ACCESS_CODE`, `EDGAR_CONTACT_EMAIL`, `TWEET_WORKER_URL`, `TWEET_WORKER_SECRET`, `TWITTERAPI_IO_KEY`, `FMP_API_KEY`, `LLM_ENABLED`, `ANTHROPIC_API_KEY`. No auth on user-facing routes; `/api/cron/daily` gated by `Authorization: Bearer $CRON_SECRET`.

## 7. CONSTRAINTS
- `SECTORS` array in `scripts/expand-sectors.mjs` + `frontend/server/lib/sectorExpansion.ts` (13 sectors, tier-banded).
- `OFFICIAL_SOURCES` in `pressReleases.ts` (7 hand-curated tickers).
- `INGESTABLE_HOSTS` in `documentIngest.ts` (18 hosts).
- `YAHOO_TO_BB` exchange map in both expand paths (excludes Argentine `BUE`).
- `BENCHMARK_MAP` in `reactionMaturation.ts` (16 aliases).
- `METRIC_LABEL_BY_KEY` in `cronDetections.ts` (23 keys) mirrors `data/metric-dictionary.json`.
- All upstream APIs (Yahoo v10, v8, SEC XBRL, GitHub Contents) are free-tier with no key rotation; 1 MB GitHub Contents inline limit worked around via `download_url` in `gitSnapshot.ts`.
