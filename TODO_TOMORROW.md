# TODO — session log 2026-07-29

All 8 items from the previous session's TODO were worked. Summary
below; audit files in `scripts/audits/`.

## Done

1. **Retry 24 quoteSummary failures** ✓ — added
   `scripts/config/us-primary-overrides.json` (22 companyId → symbol
   overrides for BDR / numeric-base / share-class mismatches). Second
   pass with the override map added ~55 new US-primary listings.
   19 residuals are legit HTTP 404s (foreign companies with no US
   listing). `add-us-primaries-v2.mjs` now spaces at 3s and logs
   failures to `scripts/audits/add-us-primaries-failures.json`.

2. **DTE / D1TE34 BZ currency outlier** ✓ — root cause was a wrong
   CIK in the registry (DTE CP carried DTE Energy's CIK 0000946770
   instead of Deutsche Telekom's 0000936340). Fixed, re-ran
   `detect-entity-groups` + `apply-entity-groups`; the wrongly-merged
   company split into two. Dropped D1TE34 BZ's past events (BR-BDR
   values were 6× off vs sibling — unreliable at this scale).
   Invariant → 0.

3. **Event-detail rendering — panel grouping** ✓ —
   `frontend/lib/metricGroups.ts` classifies each key as
   Income statement / Cash flow / Balance sheet / Derived / Other.
   `MetricRow` now takes `derived?: boolean` (opacity + badge). Event
   detail page renders 4-5 sub-panels. Past-quarters grid is
   click-to-expand per row.

4. **yahoo-timeseries backfill for newly-added US primaries** ✓ —
   `scripts/backfill-timeseries-new-primaries.mjs` (shard-aware; new
   `_US.json` shard per canonical, foreign-wrapper shards untouched).
   Fills the top-tier US primaries with 5y timeseries where SEC XBRL
   didn't have submissions. Full-population reshard-by-companyId is
   still outstanding.

5. **Estimator null triage** ✓ — split the 46 no-next-event tickers
   into 32 stale (>6mo, single-print, no cadence to infer → marked
   `dormant: true`) and 14 recent (kept as unscheduled — first prints
   from newly-added semi/annual filers).
   `scripts/mark-dormant.mjs`, audit in `dormant-triage.json`.

6. **Industry-group backfill for 151 unclassified** ✓ — 0/151 had a
   CIK, so SEC XBRL SIC was blocked. Instead:
   - 125 ETFs → `industryGroup: "ETF"` (orthogonal to sector-based
     classification; previously read as "unclassified").
   - 26 foreign operating → coarse
     `<Sector> (unclassified)` fallback from `sectorTags[0]`. Marked
     `industryGroupSource: residual-fallback` so a future Yahoo pass
     with `assetProfile.industry` supersedes it.
   `scripts/backfill-industry-residual.mjs`. Unclassified → 0.

7. **Per-metric coverage report by provenance** ✓ —
   `scripts/report-metric-coverage.mjs` + `metric-coverage.json`.
   Findings across 7,083 past events / 1,416 shards:
   - `missing-rev-with-siblings: 124` (baseline 83 — grew after
     Sweep 3 expanded the metric set; still small vs corpus).
   - Coverage per metric: revenue 86.9%, net income 86.9%,
     operating income 81.5%, gross profit 79.2%, EPS 77.0%.
   - Balance-sheet keys (cash / debt / equity) are 0% — XBRL_MAP
     doesn't cover those yet (future expansion).

8. **CI wiring for `test-standing.mjs`** ✓ —
   `.github/workflows/standing-tests.yml` runs the invariant suite
   on push to main + every PR. No new deps (Node 20 + existing
   scripts). Pipeline-report + Alphabet-corruption test in one job.

---

## Deferred (from this session)

- **Full reshard by companyId.** 291 US canonicals have no own shard;
  their events live on foreign-wrapper shards (AAPL_MM,
  BRKB80_TB, ASMLN_MM, …). Wire-level and analytics work fine
  (`gitSnapshot.readEarnings` concatenates all shards; canonical
  aggregation uses companyId), but direct-ticker UI reads on the
  US canonical only see what item 4's backfill wrote. Proper
  reshard = read all shards, group by companyId, elect canonical
  shard, migrate events into it. Non-trivial — best done with a
  dry-run + diff step so no data is lost.
- **XBRL_MAP expansion for balance-sheet metrics.** Coverage report
  shows total_cash, total_debt, shareholders_equity at 0%. Concept
  lookups exist (us-gaap:CashAndCashEquivalentsAtCarryingValue,
  us-gaap:LongTermDebt, us-gaap:StockholdersEquity) — just needs a
  patch to `frontend/server/lib/secVerbatim.ts` and a rederive.
- **`missing-rev-with-siblings: 124` residual.** The July-2026 audit
  had 83 as the baseline; the growth to 124 is entirely from Sweep 3
  expanding the tracked metric set (more sibling checks fire now).
  Sample the 124 next session to confirm no new bug.

---

**Backlog counters going into next session:**

- companies_total:                          ~1,675
- companies_with_inconsistent_financials:   **0** ✓ (DTE fixed)
- estimator_label_conflicts:                0 ✓
- estimator_nulls:                          14 (down from 46;
                                              32 flagged dormant)
- unclassified industryGroup:               **0** ✓
- reactions_pending:                        ~23k (live maturation)
- events_missing_provenance:                0 ✓
- metrics_missing_currency:                 0 ✓
- duplicates_detected:                      0 ✓

Standing tests: all green.
