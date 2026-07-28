# TODO — next session

Everything below is deferred from today's sweep-audit cycle. Ordered
by leverage.

## 1. Chase the 24 quoteSummary failures from Task 1

`scripts/add-us-primaries-v2.mjs` added 102 of 126 US-primary listings.
24 companies still don't have their US primary in the registry (Yahoo
returned "empty result" or HTTP error). Symptoms: canonical is still
a foreign wrapper (BRKB80 TB, INTC MM, ABBV MM, KO MM, PM MM, and ~19
others).

**Fix path:**
- Log to `scripts/audits/add-us-primaries-failures.json` on next run.
- Try known-symbol fallback: for tickers like BRK-B, PM, LLY the base
  guess (`guessUsPrimarySymbol`) probably picks the wrong symbol. Add
  a `manualUsSymbolOverrides.json` keyed by companyId → US Yahoo symbol.
- Re-run with the override map + concurrency 1 + 3s spacing.

**Acceptance:** BRKB US, INTC US, ABBV US, KO US, PM US, LLY US, TMO US,
XOM US canonical for their companies; all with populated latest print;
zero newly-added-empty canonicals.

## 2. Diagnose + fix DTE / D1TE34 BZ currency-scale outlier

Standing invariant `companies_with_inconsistent_financials` is currently
**1** (was 0 before the Sweep 3 metric expansion). Deutsche Telekom's
Brazilian BDR (D1TE34 BZ) stores revenue as **USD 3.5–5B** across
5 quarters while home CP listing shows **EUR 28–32B**.

- Ratio is ~6× → looks like BRL-denominated value stored as USD.
- SEC has DT's CIK (0000937797); rederive should have pulled the SAME
  ifrs-full:Revenue for both listings. Check whether D1TE34 BZ's
  companyId actually joined DTE CP's group (verify by grouping) —
  might be a companyId mismatch, not a currency bug.

**Acceptance:** `companies_with_inconsistent_financials` drops back to
0; both listings agree; corruption-test baseline count returns to 0.

## 3. Extend event-detail rendering for the expanded metric set

Sweep 3 + Part 4 added ~3,449 sec-verbatim metrics + 17,658 derived
metrics across every US-CIK company (cost of revenue, pretax income,
OCF, capex, cash/debt/equity, shares, gross/operating/net margin, FCF).
`MetricRow` already renders them but they're a flat list.

Prompt spec: group event detail into panels — Income statement / Cash
flow / Balance sheet / Derived. Derived metrics render visually
distinct (subtle opacity or badge) so analysts see reported vs computed.

**Files to touch:** `frontend/app/s/[ticker]/e/[eventId]/page.tsx`
or `frontend/components/security/OperatingDetail.tsx`.

**Acceptance:** MSFT US latest print shows 4 metric groups; margins
and FCF marked derived; past-quarters grid stays compact (revenue,
net income, EPS + click-to-expand).

## 4. Backfill yahoo-timeseries for the newly-added 102 US primaries

The new US-primary listings have SEC-verbatim data from rederive, but
they don't have yahoo-timeseries data (chart-derived revenue for
earlier quarters where SEC didn't file). Would round out history for
companies with pre-2020 quarters.

**Fix:** `node scripts/backfill-yahoo-timeseries.mjs --tickers=AAPL_US,NVDA_US,...`
or add a per-ticker flag.

## 5. Investigate why 46 estimator shells still return null

Post-rederive, `run-estimator.mjs` reports:
- `already has next shell:   1369`
- `estimator returned null:  46`

These are past-event tickers where cadence detection fails (irregular
filers per the earlier triage). Not necessarily broken — they render
as "unscheduled" honestly. Worth one look to see if any deserve a
`dormant` registry flag.

## 6. Bulk industry-group backfill for the 151 unclassified

`apply-entity-groups.mjs` reports 151 still unclassified (foreign
tickers where Yahoo `assetProfile` didn't return `industry`). Not
critical — they render as `Unclassified` in cap-band × industry views.
Rerun `scripts/backfill-industry-groups.mjs` on the ones with
edgarCik — SEC XBRL sometimes reports `EntityRegistrantSector` /
`sic` codes.

## 7. Add per-metric before/after population table by provenance

Sweep 3 asked for this report; I have the baseline (`83 events
missing revenue with siblings`) but never captured the after count.
Quick script — walk shards post-rederive, produce the same by-provenance
table.

**Acceptance:** shows the ~83 count dropped to a small residual;
per-metric coverage lists for the 14 newly-tracked metrics.

## 8. Standing-tests wiring for CI

`scripts/test-standing.mjs` currently runs on demand. If we want the
invariants proven on every commit, wire it into a lightweight GitHub
Action — no new deps needed, just node + the existing scripts. Would
catch companyId regressions before they land.

---

**Backlog counters going into tomorrow:**

- companies_total: 1,652
- companies_with_inconsistent_financials: **1** (DTE — item 2)
- estimator_label_conflicts: 0 ✓
- reactions_pending: ~23k (live maturation, not stale)
- marketcap_stale_count: 117 / 1,652 = 7% (within threshold)
- events_missing_provenance: 0 ✓
- metrics_missing_currency: 0 ✓
- shard_index_mismatches: 0 ✓
- duplicates_detected: 0 ✓

Standing tests: all green.
