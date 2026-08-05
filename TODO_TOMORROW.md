# TODO (short list — surfaced from prompt1.txt sessions)

Small named items that need a follow-up, not fresh design work.

## Post-refresh follow-ups (2026-08-05)

Not blocking, but worth doing when you have time:

1. **AAPL retry** — still `kpi-only`, no extendedMetrics. Batch didn't
   reach it after the 8-K exhibit resolver fix (commit 6a669fb9).
   Manual trigger `/earnings AAPL US` needed via
   `.github/workflows/claude-summarize.yml` dispatch.

2. **SP500 batch resumption** — the `regenerate-summaries` batch ran
   25 tickers before hitting the workflow's 24h timeout / `--max-turns`
   cap. Only 25/491 SP500 have extendedMetrics. Fire another
   `regenerate-summaries.yml` with `source=sp500`, `start_at=25`,
   `limit=30` to continue.

3. **/sweep for 2026-08-05 reports** — the refresh workflow's step 7
   (chain to `/sweep`) got skipped because step 5 exited 1. Any
   companies that reported today didn't get automatically summarized.
   Optional manual `/sweep` trigger via `claude-summarize.yml`.

4. **6 residual report-attachment violations** — will auto-heal in
   tomorrow's 03:00 UTC cron. No action needed.

## Actionable

- **PSN US ↔ PSNY US revenue drift (co-7f5a4f7089, Polestar).** Both
  ADRs of the same CIK 0001884082 report USD, but per-listing Yahoo
  timeseries ingest produced PSN=1491M and PSNY=633M for FY2026 Q1 —
  the exact per-listing snapshot drift the SEC-verbatim rule was
  built to prevent. Fix: next cron cycle that touches either ticker
  should trigger the per-companyId SEC-verbatim reconciliation in
  `frontend/server/lib/secVerbatim.ts` and distribute one canonical
  value to both. If it doesn't self-heal in 24h, run manually:
  `node scripts/backfills/rederive-sec-xbrl.mjs --company=co-7f5a4f7089`.
  Currently the single reason keeping `pipeline-report.json` in
  `degraded` — an accurate signal for a real cross-listing bug, not
  a false alarm.

## SP500 completeness (Phase 4) follow-ups

- **`scripts/attach-sec-filings.mjs --scope=sp500-all`** — attaches
  SEC accession-URL sourceLinks to prior-4-quarter events (this
  session's run covered latest-only, ~210/458 attached). SEC 1
  req/s pacing means the full sp500-all sweep is ~40 min;
  checkpointed to `fetched/attach-sec-filings.checkpoint.json` so
  resumable across runs. Run in background: current
  `reported_without_document=8,585` universe-wide (Phase 2 ingest
  brought +425 shards with Yahoo-timeseries actuals but fallback
  sourceLinks — the mechanical sweep converts them).
- **`--scope=all`** — full universe (~2h+). Only worth doing after
  SP500 close-out.
- **248 no-match SP500 latest quarters** — pickBestFiling
  returned nothing within ±14 days of eventDate. Most are
  fiscal-offset issuers where Yahoo's quarter-end placeholder
  date is off from the actual filing date. Fix: run
  `scripts/fetch-real-report-dates.mjs` first (SP500 subset), then
  re-run attach-sec-filings — the ±14 day window should catch
  most.
- **Atomic-promotion rule (going-forward, Phase 4 j)** — modify
  `scripts/mature-any-reported.mjs` + the cron path so a CIK-
  bearing promotion also resolves + attaches the SEC document in
  the same run. Current script writes `sourceLink.kind="fallback"`
  which the new report-attachment counter catches. Sketch is in
  place; enforcement stays TODO until the same-run doc resolver
  code path lands.
- **`sp500_complete_pct = 0%` today** — even with 210 documents
  attached, sp500_complete_pct requires all four layers (results
  with real date + document + estimates + reaction). Estimates
  are the biggest gap (Yahoo timeseries doesn't carry consensus).
  Follow-up: run `ingest-estimates-universe.mjs` targeted at
  SP500, then reactions maturation.

## IR-source registry follow-ups

- **`scripts/apply-ir-source-discoveries.mjs`** — the merger script
  referenced from `.claude/commands/earnings.md` Step 1 Rung 4
  write-back. Its job: read the `irSourcesUpdate` field from
  recently-written summaries in `data/summaries/`, dedupe against
  the registry, and merge with source "observed". Contract is
  wired in the /earnings command; implementation stays TODO until
  we have a first summary with an `irSourcesUpdate` payload to
  test against. No urgency — the ladder falls through gracefully
  without it (WebSearch just doesn't self-improve the registry
  yet).
- **Researched pass** for the ~1,344 entities still with null
  `reports_page_url` after observed + derived. Scope this to
  the covered tier + top ~50 uncovered by market cap. Requires a
  bounded WebFetch per ticker: find the results/PR archive page
  (not the homepage), confirm it lists the latest quarter, record
  URL + any RSS feed + a publication_pattern line. Currently only
  1 covered ticker (BOLSY US) has null `publication_venue` — this
  is a targeted follow-up, not a broad sweep.
- **Fix AAPL US's next scheduledDate** — currently stamped
  `2026-08-03`, which is wrong (Apple's Q4 fiscal reports late
  October). Estimator placeholder. Should self-heal on next
  cron cycle once mature-any-reported picks up the actual Q3
  release from 2026-07-30.

## Refresh workflow cutover

- **Uncomment the `.github/workflows/refresh-data.yml` schedule line
  once GitHub Actions minutes reset** (check Settings → Billing for
  the reset date). First run manually via `workflow_dispatch`; verify
  it lands green twice; THEN disable the Vercel cron trigger in
  `frontend/vercel.json`. The two-successes-before-cutover rule from
  the migration plan applies.
