# TODO (short list — surfaced from prompt1.txt sessions)

Small named items that need a follow-up, not fresh design work.

## Rederive SEC-XBRL match bug (2026-08-25)

Universe audit turned up systemic revenue-value mismatches vs SEC —
same class of bug across every fiscal-offset issuer. Full evidence
at `scripts/audits/revenue-reality-check.json`
(schema `revenue-reality-check/v1`).

**Root cause.** SEC's XBRL API returns each pure-quarter fact TWICE:
once when originally filed (labeled with the reporting fiscal year)
and again as a prior-year comparative in the NEXT year's 10-Q
(labeled with THAT filing's fiscal year — even though the fact's
actual `end` is a year earlier). Both facts pass an `fy+fp+80-100d`
filter, so `scripts/backfills/rederive-sec-xbrl.mjs`'s
`extractQuarterValues()` picks the WRONG one on issuers whose fiscal
calendar creates label overlap (NVDA, INTU, MU, AAPL international,
etc.). The right key is SEC `filed`-date proximity to the event's
`eventDate`, then pick the fact whose `end` is closest to but
before `filed` (the reporting quarter, not the year-old comparative).

**Audit results — top offenders (101 flagged, 38 CIKs, 8204 checked):**

| CIK | Company | Listings | Events | Max Δ |
|---|---|---:|---:|---:|
| 1045810 | NVDA | 5 (US + MM + BZ + CN + TB) | 21 | 85% |
| 104169 | WMT | 3 | 9 | 7% |
| 88941 | SMTC | 2 | 8 | 16% |
| 320193 | AAPL | 3 international | 6 | 23% |
| 100591 | ARG FP / 871 GR | 2 | 4 | 50% |
| 924805 | FRHC US | 1 | 2 | 110% |
| 896878 | INTU | 1 | 2 | 84% |
| 723125 | MU | 1 | 2 | 75% |
| 1666700 | DD US | 1 | 2 | 46% |

Delta bands: 60 events at 5-20%, 30 at 20-50%, 10 at 50-100%, 1 >100%.

**Two-part fix (~30 min total):**

1. **Fix `rederive-sec-xbrl.mjs`** — replace the `fy+fp` matcher in
   `extractQuarterValues()` with a `filed`-date matcher, mirroring
   `pickMatchingFact()` in `scripts/audits/revenue-reality-check.mjs`.
   Match by SEC `filed` within ±3 days of `event.eventDate`, then
   among matches pick the fact whose `filed - end` gap is smallest
   (the current-quarter fact, not the year-old comparative).

2. **Rerun rederive on the 38 flagged CIKs** — targeted, not
   universe-wide. After it lands, regenerate `data/events-index.json`
   so the watchlist Y/Y-growth chip uses the corrected values.
   Spot-check NVDA + INTU + MU + AAPL post-run.

**Also worth adding as belt-and-suspenders:** wire the reality-check
into a nightly guard (`scripts/audits/revenue-reality-check.mjs` as
a new phase in `scripts/audits/full-audit.mjs`, or its own audit
step). Failing loud on new mismatches is cheaper than the manual
audit we ran today.

## Watchlist Y/Y-growth chip — follow-ups from 2026-08-25

Everything else from the same session:

- **NVDA Y/Y showed -46%** in the Y/Y-rev-growth chip that shipped in
  commit `b8a743cc8`. Root cause is the rederive bug above (value
  swap in shard). Will auto-clear once the CIK rederive fix lands.
- **`_crossBasisSurprise` label wording** — the pill currently says
  "reported · basis mismatch" for the SP500 rows without Y/Y data.
  Consider tightening the tooltip explanation (only ~4 rows fall
  into this bucket now, but the label still shows).
- **Two `SortKey` types living in separate files** (WatchlistTable +
  WatchlistFilterPopover) — unify. Non-urgent; caused a Vercel
  build break during the pill-strip commit but the fix was a
  one-line add.

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
