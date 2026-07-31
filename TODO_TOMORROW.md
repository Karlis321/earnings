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

## Refresh workflow cutover

- **Uncomment the `.github/workflows/refresh-data.yml` schedule line
  once GitHub Actions minutes reset** (check Settings → Billing for
  the reset date). First run manually via `workflow_dispatch`; verify
  it lands green twice; THEN disable the Vercel cron trigger in
  `frontend/vercel.json`. The two-successes-before-cutover rule from
  the migration plan applies.
