---
description: Produce a post-earnings summary for one ticker → data/summaries/<TICKER>_<PERIOD>.json
argument-hint: TICKER [PERIOD]
---

Run the earnings-summary procedure for `$ARGUMENTS`. `$ARGUMENTS` is
`TICKER [PERIOD]` where `TICKER` is a Bloomberg-style ticker (space
between root and country code, e.g. `HBM US`) and `PERIOD` optional
(e.g. `FY2026 Q2`). If `PERIOD` is omitted, use the ticker's latest
past event from `data/events/<TICKER_SLUG>.json` (slug = ticker with
`_` for space).

Ledger discipline: every figure comes from the primary document.
Never aggregators. Never invent. Never "vs consensus".

## Procedure

1. **Resolve to canonical.** Load `data/entity-registry.json`. Find
   the entity with `ticker === "$1"`. If `isCanonical === false`,
   walk `companyId` and use the canonical member's ticker. Record
   `companyId`, `edgarCik`, `displayName`.

2. **Determine period + report date.** Load the canonical's shard
   `data/events/<slug>.json`. If `$2` given, find the event with that
   `period`. Otherwise take the latest past event (`eventDate` set,
   sorted desc). Record `period`, `eventDate` — this is `reported_at`.

3. **Fetch the primary document.** WebSearch for the exact press
   release / 10-Q / 6-K for that ticker + period. Prefer:
   - Company IR: `investors.<company>.com`, `<company>.com/investors`,
     `<company>.com/newsroom`
   - EDGAR: `www.sec.gov/cgi-bin/browse-edgar?CIK=<edgarCik>`
   - Company-linked Q4 / GlobeNewswire release URLs

   Blocklist (validator will reject): Yahoo, Reuters aggregator,
   SeekingAlpha, MarketWatch, CNBC, Bloomberg, Investing.com, Zacks,
   Motley Fool, Benzinga. WebFetch the primary URL to confirm it
   contains the period-specific figures. Save the exact URL as
   `source_url`.

4. **Extract with ledger discipline.**
   - Every KPI cited must appear verbatim in the document (± the
     rounding the company itself used). No mental math beyond what
     the release publishes.
   - For miners: segregate **C1 cash cost** (cash operating cost
     per unit) from **AISC** (all-in sustaining cost). Never
     conflate. Note by-product netting where applicable — e.g.
     copper net-of-gold-credits vs gross.
   - Streaming / royalty distortions (Wheaton, Franco, etc.):
     note the streamed vs non-streamed split if the release
     provides it.
   - Comparison basis rules:
     - **q/q** — compare vs prior quarter using the same
       shard's previous event (walk `data/events/<slug>.json`).
     - **vs guidance** — only if the company explicitly gave
       guidance for this period (search prior earnings shard
       for a `guidance` array with a matching period). Use the
       midpoint of the range.
     - **y/y** — compare vs same quarter last year, again from
       the shard.
     - **none** — for first-print or non-comparable metrics.
   - **NEVER "vs consensus"**. We don't carry sell-side consensus
     with confidence; do not fabricate one.

5. **Write the summary.** Compose the JSON exactly matching
   `data/summaries-schema.json`. File path:
   `data/summaries/<TICKER_slug>_<PERIOD_slug>.json`. Both slugs
   replace spaces with `_`. Example: `HBM_US_FY2026_Q2.json`.
   Rules from the schema:
   - `headline` ≤ 60 chars, verdict-style, NO digits.
   - `summary_short` 1-2 sentences, MUST contain ≥1 number.
   - `summary_long` ≤ 120 words. Drivers + guidance change +
     balance sheet. No filler, no forward speculation.
   - `kpis[]` — each row: `label`, `value` (formatted with unit),
     `delta` (formatted, or null when `delta_basis="none"`),
     `delta_basis ∈ {q/q, y/y, vs guidance, none}`,
     `direction ∈ {up, down, flat, n/a}`.
   - `confidence_notes` — restatements, C1-vs-AISC quirks,
     by-product notes, one-offs. Empty string if none.

6. **Validate.** Run `node scripts/validate.js
   data/summaries/<file>.json`. Fix any errors. Standing tests
   (`scripts/test-standing.mjs`) also invariant-check summaries;
   run that too. Do not proceed to commit until both are green.

7. **Commit + push.** `git add data/summaries/` then commit with
   message `earnings: <TICKER> <PERIOD>`, then push.

8. **Report.** Print: ticker, period, headline, "validation
   passed", "push done".

## Failure modes — abort, don't paper over

- **Primary source unavailable** — company site down, EDGAR 404 for
  the CIK+period, no company release exists yet. Stop. Say
  "no primary source available for <TICKER> <PERIOD>, deferring".
  Do not fall through to an aggregator.
- **Period not in shard** — the requested period has no past event.
  Say so. Don't invent one.
- **Ledger inconsistency** — release publishes figures that don't
  reconcile (e.g. sum of segments ≠ total). Note in
  `confidence_notes`, don't silently massage.
