---
description: Produce a post-earnings summary for one ticker → data/summaries/<TICKER>_<PERIOD>.json
argument-hint: TICKER [PERIOD]
---

Run the earnings-summary procedure for `$ARGUMENTS`. `$ARGUMENTS` is
`TICKER [PERIOD]` where `TICKER` is a Bloomberg-style ticker (space
between root and country code, e.g. `HBM US`) and `PERIOD` optional
(e.g. `FY2026 Q2`).

Ledger discipline: every figure comes from the primary document or
from our own SEC-verbatim event data — never aggregators, never
invented, never "vs consensus".

**Speed principles** (this pipeline runs in CI on a paid clock):

- Every local read comes before every web tool. Step 0 finishes
  most of the resolution work without touching the network.
- KPI values come from our own event data. The fetched document is
  used ONLY for narrative, guidance changes, and confidence notes.
  This is a read-once-write-once flow, not an extract-everything
  flow.
- Hard budget: **max 2 WebSearch calls, max 3 WebFetch calls** per
  run. If the document can't be obtained inside that budget,
  `RESULT: skipped — source unreachable, <detail>` and stop.
  Never loop on the same fetch.

## Step 0 — Local resolution (no web, no exceptions)

Do these in order, all reads local:

a. **Resolve ticker → canonical.** Load
   `data/entity-registry.json`. Find the entity with the given
   ticker. If `isCanonical === false`, walk `companyId` to the
   canonical member. Record `ticker` (canonical), `companyId`,
   `edgarCik`, `displayName`.

b. **Determine period + report date.** Load the canonical's shard
   `data/events/<slug>.json` (slug = ticker with `_` for space).
   If PERIOD was given as `$2`, find the event with that
   `period`. Otherwise take the latest past event (`eventDate`
   set, sort desc). Record `period` and `eventDate`.

c. **Guard: already done?** If
   `data/summaries/<TICKER_slug>_<PERIOD_slug>.json` already
   exists AND `node scripts/validate.js` on it returns exit 0,
   print `RESULT: skipped — already exists` and STOP. This
   check MUST run BEFORE any WebSearch or WebFetch. Do not
   invoke the network just to confirm the file is fine.

d. **Read the shard's `sourceLink`.** Every event carries
   `{url, kind}`. If `kind === "filing"`, that URL IS the
   primary document — skip the search step and fetch it
   directly (counts as 1/3 fetches). Otherwise
   (`kind === "fallback"` or missing) fall through to Step 1.

   **For any `sec.gov` URL**, use
   `Bash: node scripts/fetch-edgar.mjs <url> <outfile>` and
   then `Read` the outfile. WebFetch anonymous datacenter
   requests to SEC come back 403; the script sends the
   contact-bearing User-Agent SEC requires and respects
   the ≤1 req/sec cap across invocations via a lockfile.
   WebFetch is still the right tool for non-SEC URLs.

e. **Read the reported metrics from the shard.** These already
   carry SEC-verbatim values (revenue, net income, EPS, gross/
   operating/net margins, cash flow, balance sheet — see
   `frontend/lib/metricGroups.ts` for the full set). Use them
   verbatim as the KPI values for the summary. Only fields that
   are shard-`undefined` need to come from the release.

## Step 1 — Fetch the primary (only if Step 0d didn't land one)

- **One** WebSearch, query:
  `"<displayName> <period> results press release"`. Prefer
  results from `investors.<company>.com`, `<company>.com`,
  `sec.gov`, or `edgar.sec.gov`. Blocklist (validator will
  reject): Yahoo, Reuters aggregator, SeekingAlpha,
  MarketWatch, CNBC, Bloomberg, Investing.com, Zacks, Motley
  Fool, Benzinga.
- Prefer EDGAR/SEC URLs over corporate IR pages when both are
  in the search hits. **IR sites often block datacenter IPs;
  EDGAR does not** (as long as you use `scripts/fetch-edgar.mjs`
  for the actual fetch — anonymous requests to sec.gov 403).
- For `sec.gov` URLs use
  `Bash: node scripts/fetch-edgar.mjs <url> <outfile>` +
  `Read`. For any other URL use WebFetch. Each fetch —
  whether via the script or WebFetch — counts one against
  the 3-fetch budget.
- **If a fetch fails twice, DO NOT retry it.** Go straight
  to the EDGAR filings index for the CIK
  (`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<edgarCik>&type=&dateb=&owner=include&count=10`)
  as fetch #3, find the 10-Q / 10-K / 6-K covering the period,
  fetch that. That's the budget cap.
- If still no document after 2 searches + 3 fetches,
  `RESULT: skipped — source unreachable, <detail>` and STOP.

## Step 2 — Compose the summary

The KPI values are already in hand from Step 0e (SEC-verbatim
shard metrics). The fetched document supplies ONLY:

- The `headline` verdict (from the release's own tone / lead
  sentence).
- The `summary_short` and `summary_long` narrative — drivers,
  operational commentary, and *guidance changes* (raised /
  lowered / reaffirmed for what specific line items).
- `confidence_notes` — restatements, one-offs, C1-vs-AISC
  quirks, by-product netting, streaming distortions,
  currency translation quirks.

Compute deltas for each KPI:

- **q/q**: prior event in the same shard (walk one back).
- **y/y**: event 4 quarters earlier in the same shard.
- **vs guidance**: only if the company gave explicit guidance
  for this period AND the prior shard events carry a
  matching `guidance` entry (use its midpoint).
- **none**: first-print or non-comparable metrics.
- **NEVER "vs consensus"**.

Miner-specific rules (Hudbay, Capstone, Taseko, Century,
Hudbay, etc.):

- Segregate **C1 cash cost** (per-unit operating cash cost)
  from **AISC** (all-in sustaining cost). Never conflate.
- Note by-product netting — copper C1 net of gold/silver/
  molybdenum credits vs gross.
- Streaming / royalty distortions: split streamed vs
  non-streamed if the release provides it.

Write the JSON to
`data/summaries/<TICKER_slug>_<PERIOD_slug>.json` matching
`data/summaries-schema.json`. Rules:

- `headline` ≤ 60 chars, verdict-style, **no digits** (the
  validator enforces this).
- `summary_short` 1–2 sentences, MUST contain ≥1 number.
- `summary_long` ≤ 120 words. Drivers + guidance change +
  balance sheet. No filler, no forward speculation.
- `kpis[]` — `label`, `value` (with unit), `delta`
  (formatted, or null when basis is `none`),
  `delta_basis ∈ {q/q, y/y, vs guidance, none}`,
  `direction ∈ {up, down, flat, n/a}`.
- `confidence_notes` — empty string if genuinely nothing to
  note.

## Step 3 — Validate + commit + push

1. `node scripts/validate.js data/summaries/<file>.json`. Fix
   errors and re-run. Then `node scripts/test-standing.mjs`.
   Both green, or STOP.
2. `git add data/summaries/`, commit
   `earnings: <TICKER> <PERIOD>`, push.
3. Print exactly one of:
   - `RESULT: committed <filename>`
   - `RESULT: skipped — <reason>`
   No other closing line.

## Failure modes — abort, don't paper over

- **Primary source unreachable** — inside the 2-search/3-fetch
  budget, no non-aggregator document loaded. `RESULT: skipped
  — source unreachable, <detail>`. Do NOT fall through to an
  aggregator to "get something".
- **Period not in shard** — the requested period has no past
  event. `RESULT: skipped — period not in shard`.
- **Ledger inconsistency** — release publishes figures that
  don't reconcile (e.g. sum of segments ≠ total). Note in
  `confidence_notes`, don't silently massage.
- **Validator failure after retry** — commit is blocked until
  the file passes. If a schema violation can't be fixed
  without inventing data, `RESULT: skipped — <specific
  validator error>`.
