# TODO (short list — surfaced from prompt1.txt sessions)

Small named items that need a follow-up, not fresh design work.

## Fiscal-quarter period labels on US canonicals (2026-08-26 EOD)

Universe consistency check (pipeline-report at commit 92fa0dd15):
`companies_with_inconsistent_financials = 10`. All 10 are US
canonicals with fiscal-offset calendars where the shard's `period`
LABELS on the US listing don't align with SEC's actual reported
fiscal quarter, while international siblings correctly label the
same event.

**Concrete evidence — AAPL:**

```
AAPL US    · eventDate=2026-07-30 · period=FY2026 Q2 · rev=109417
AAPL MM    · eventDate=2026-07-28 · period=FY2026 Q3 · rev=109417
AAPL34 BZ  · eventDate=2026-05-01 · period=FY2026 Q2 · rev=111184
AAPL CN    · eventDate=2026-05-01 · period=FY2026 Q2 · rev=111184
```

International sees the July filing as Q3 (SEC-correct). US canonical
labels it Q2 — one quarter behind. Cross-listing invariant then
fires because it groups by (companyId, period) and sees Q2 = 109417
on the US side vs 111184 on the international side.

The 10 affected companies (from pipeline-report samples):
`co-01f774ce0f` (ARG US), `co-58f3e88c79` (AAPL US),
`co-615cb261a4` (AMAT US), `co-7f46f61734` (CSCO US),
`co-f42b130ba6` (HD US), plus 5 more with same pattern.

Values per event are already correct after today's
rederive-sec-xbrl fix. Only the period LABEL on the US canonical
needs remapping — probably a Yahoo ingest that assumed calendar
quarters when the issuer files against a fiscal year.

**Fix path:** for each of the 10 CIKs, read SEC's `fp+fy` on the
current-quarter fact matched to each event's `eventDate` (same
filed-date match already implemented in rederive), then overwrite
`event.period` to `FY<sec.fy> Q<sec.fp[1]>`. Scripted, ~15 min.

Ship this and standing-tests goes green (only reason
`pipeline-report status = degraded` is still stuck on that
`companies_with_inconsistent_financials=10` reason, which isn't on
`KNOWN_EXCEPTIONS`).

## ✅ FIXED — Sector-ideas guard/audit mismatch (2026-08-26)

**Root cause found + fixed same day.** The sector-ideas workflow's
step 1 re-runs `aggregate-by-sector.mjs` before Claude fires, to
give the narrative writer a freshened headline window. Claude
validates against that freshened `sector-signals.json` (v2). But
the playbook's git-add line only staged `data/sector-ideas.json`,
NOT `sector-signals.json` — so origin stayed at v1 (from 03:00
refresh) while sector-ideas cited v2 headlines. Audit at 06:30
checked out v1 and flagged every rolled-over headline as
`NEW_HALLUCINATION`.

Fix in `a95d3b8b1`: playbooks (`.claude/commands/sector-ideas.md`
Step 4 + `.claude/commands/week-ahead.md` Step 5) now stage the
regenerated snapshots alongside the primary output. Tomorrow's
audit-daily should see 0 sector-ideas hallucinations.

Verify by watching Thu 2026-08-27 06:30 UTC audit — if it goes
green (or at least has `hallucinations: 0` in the artifact), the
fix took.

Original evidence at
`scripts/audits/history/full-audit-2026-08-26T07-06-38Z.json`.

**What made it through the write-time guard that shouldn't have.**
`apply-sector-ideas.mjs`'s `headlineIndex check` (see the guard at
`scripts/apply-sector-ideas.mjs:158-184`) is supposed to reject any
LLM `keyHeadline` that isn't in the sector's `recentHeadlines[]`
with matching `ticker + "||" + headline`. Yet 13 cited headlines
made it through. Same key format is used by the audit's F17 check
in `scripts/audits/full-audit.mjs:148-160`, so if the guard passed
them the audit should too — but the audit is finding mismatches.

**Pattern in the flagged rows:** most are SEC-filing auto-titles the
LLM shouldn't cite as themes at all —
`"4 - Statement of changes in beneficial ownership of securities"`,
`"3 - Initial statement of beneficial ownership of securities"`,
`"8-K - Current report"`, `"144 - Report of proposed sale of
securities"`. Plus a handful of real news that got mismatched
(SHEL/EOG/COIN/INTC — the last two are cross-sector cites where
the ticker/headline pair exists in ONE sector's `recentHeadlines[]`
but not the one the theme claims).

Two probable causes to investigate:
1. **Guard/audit reading different snapshots.** The guard reads
   `sector-signals.json` at 06:00 UTC (sector-ideas time); audit
   reads it at 06:30 UTC. If some phase mutates sector-signals
   between them (unlikely per current phase order, but check),
   the two would see different `recentHeadlines[]` sets. Confirm
   by running the same F17 check against sector-signals.json
   **as of the sector-ideas write time** (git-log at 07:04 UTC on
   `data/sector-signals.json`).
2. **Subtle string normalization difference.** The guard might
   trim/normalize whitespace (SEC titles often have double-space
   between form number and dash — `"4  - Statement"`) while the
   audit does exact match, or vice-versa. Log the raw `key`
   strings on both sides of a mismatch to compare.

**Also worth adding to the sector-ideas prompt / command:** an
explicit "don't cite SEC compliance-filing titles (Form 3/4/8-K/144)
as thematic evidence" line. Those forms are the SEC's own
housekeeping and never carry the narrative signal a theme needs.

## ✅ FIXED — Rederive SEC-XBRL match bug (2026-08-25 → fixed 2026-08-26)

**Root cause found + fixed same day.** `extractQuarterValues()`
in `rederive-sec-xbrl.mjs` anchored to a calendar-quarter end
derived from event.period ("FY2026 Q1" → "2026-03-31") and picked
the SEC fact whose `end` was within ±31 days. For fiscal-offset
issuers (NVDA Feb-Jan, AAPL Sep-Sep, MU Aug-Aug, INTU Jul-Jul,
SMTC Feb-Jan) the label-derived calendar anchor lands 11-12 months
off from the real quarter-end, and the ±31-day tolerance latched
onto the NEXT fiscal year's same-quarter value. NVDA's FY2026 Q1
stored $81.6B (real: $44.1B — the $81.6B is FY2027 Q1's value).

Fix in `157aaa005`: match by SEC `filed`-date proximity to
event.eventDate (±3 days), then among facts sharing the filing
date pick the one with the smallest `filed - end` gap (the
reporting quarter, not the year-old comparative). Same pattern as
`pickMatchingFact` in `scripts/audits/revenue-reality-check.mjs`.

Also added `--cik=<csv>` filter for surgical fix runs.

**Live rerun in `2aefa6704`** on all 38 CIKs from the audit:
  · 155 events touched
  · 1054 metrics replaced, 784 added
  · 59 shards updated

Post-fix universe re-audit in progress at time of TODO update —
at 22% coverage: 0 flagged (vs 67 at same point pre-fix).

**Y/Y-growth chip check post-fix:**
  NVDA US → +85.2% (was -46%)  ✓ real Q1 FY2027 vs FY2026
  GOOGL US → +24.2% (unchanged) ✓
  AAPL US → +16.4% (unchanged) ✓
  INTU US → +10.4% (previously flagged, now sane)

**Two residuals worth eyeing tomorrow:**
  MU US → +345.7% (large; Micron sold their subsidiary in 2024 so
    the revenue base did move materially, but 345% seems too much
    — possibly a separate class of ingest mislabel that our Q1-Q4
    filter misses. Check whether MU stores an fp='FY' fact that
    slipped through).
  APTV US → -37.1% (Aptiv corporate carve-outs in flight; check
    whether the shift is stored correctly).

Original evidence at `scripts/audits/revenue-reality-check.json`
(pre-fix) and `scripts/audits/revenue-reality-check-post-fix.log`
(post-fix run).

---

## Original TODO from 2026-08-25 — Rederive SEC-XBRL match bug

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
