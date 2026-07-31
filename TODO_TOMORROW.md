# TODO (short list — surfaced from prompt1.txt sessions)

Small named items that need a follow-up, not fresh design work.

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
