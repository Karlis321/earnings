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

**Tooling rule — hard.** Every data operation goes through a script
in `scripts/`. Never `node -e`, `python3`, `wc`, `awk`, `sed`, or any
other shell one-liner improvisation. The CI sandbox blocks most of
them and you'll waste turns on the recovery. If the operation you
need has no script, the correct move is
`RESULT: skipped — tooling gap: <describe what would need to exist>`
and stop. That converts a sandbox collision into a named backlog
item instead of a self-recovery loop.

Sanctioned scripts:

- `scripts/resolve-earnings-target.mjs <TICKER> [PERIOD]` — Step-0
  resolver, prints one JSON object with everything Step 0 needs.
- `scripts/fetch-edgar.mjs <sec.gov-url> [outfile]` — SEC-compliant
  fetcher; writes to `./fetched/<basename>` by default.
- `scripts/extract-doc-text.mjs <html-file> [--grep "pattern"]` —
  HTML → text (writes `.txt` beside the input), or `--grep` for
  targeted matches with 2 lines of context.
- `scripts/validate.js <summary.json>` — schema + filename +
  aggregator-URL check.
- `git *` — for the final add / commit / push.

**Speed principles:**

- KPI values come from our own SEC-verbatim event data (returned by
  `resolve-earnings-target.mjs`). The fetched document supplies
  ONLY the narrative, headline verdict, guidance change, and
  confidence notes.
- Hard budget per run: **max 2 WebSearch, max 3 fetches**
  (`fetch-edgar` and WebFetch both count). Extract-doc-text is
  local and free.
- Never loop on the same fetch — if it fails twice, either fall
  through to EDGAR via the CIK or `RESULT: skipped — source
  unreachable, <detail>`.

## Step 0 — Local resolution (one script call)

Run `Bash: node scripts/resolve-earnings-target.mjs "<TICKER>" [PERIOD]`.
Parse the JSON on stdout. The object gives you:

- `canonicalTicker`, `companyId`, `edgarCik`, `displayName`,
  `reportingCurrency`, `securityType`
- `period`, `eventDate` — target event's fiscal period and its
  report date on the shard (the report date is used as
  `reported_at`; if you obtain a more authoritative date from the
  fetched primary, prefer that and note the mismatch in
  `confidence_notes`).
- `sourceLink: {url, kind}` — event-level source; `kind: "filing"`
  means Step 1 can skip search and fetch this URL directly.
- `priorPeriodQq`, `priorPeriodYy` — labels for the q/q and y/y
  reference periods.
- `summaryPath`, `summaryExists`, `summaryValidates`,
  `summaryReady` — if `summaryReady === true`, print
  `RESULT: skipped — already exists` and STOP. Do not touch the
  network.
- `kpis: {<metric>: {value, unit, provenance, derived, prior_qq,
  prior_yy}}` — every populated metric on the target event, with
  q/q and y/y prior values pre-joined. This is the KPI source of
  truth. Only fields not in `kpis` need to come from the release.

If the resolver exits 2, its stderr line explains why (unknown
ticker, period missing from shard, etc.). Print
`RESULT: skipped — <exact resolver message>` and STOP.

## Step 1 — Fetch the primary (only when needed)

If `sourceLink.kind === "filing"`, use `sourceLink.url` directly.
Otherwise **one** WebSearch:
`"<displayName> <period> results press release"`. Prefer results
on `investors.<company>.com`, `<company>.com`, `sec.gov`, or the
company's IR host. Blocklist (validator will reject the summary):
Yahoo, Reuters aggregator, SeekingAlpha, MarketWatch, CNBC,
Bloomberg, Investing.com, Zacks, Motley Fool, Benzinga.

**Prefer EDGAR/SEC URLs** when both an IR page and a filing exist.
IR sites frequently block datacenter IPs; EDGAR is reliable via
`fetch-edgar`.

Fetch:

- For any `sec.gov` URL: `Bash: node scripts/fetch-edgar.mjs <url>`
  → the script writes to `./fetched/<basename>` and prints the path
  and byte count to stdout. Counts as one fetch.
- For non-`sec.gov` URLs: WebFetch. Counts as one fetch.

If a fetch fails twice, DO NOT retry it. Go straight to the EDGAR
filings index for the CIK
(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<edgarCik>&type=&dateb=&owner=include&count=10`),
fetch that via `fetch-edgar` (3rd/final fetch), pick the 10-Q /
10-K / 6-K covering the period, fetch that. Two searches + three
fetches is the total budget — after that,
`RESULT: skipped — source unreachable, <detail>`.

## Step 2 — Read the document

Fetched HTML files are typically 200KB-1MB — larger than the Read
tool's 256KB limit. Two options:

- **Extract to text first** (default):
  `Bash: node scripts/extract-doc-text.mjs fetched/<file>` writes a
  plain-text `.txt` beside the source. `Read` that.
- **Targeted grep** (large docs where text is still >256KB):
  `Bash: node scripts/extract-doc-text.mjs fetched/<file>
  --grep "cash cost"` prints matching lines with 2 lines of
  context. Ideal for pulling specific figures (C1, AISC,
  production, guidance, by-product credits) without reading the
  whole thing.

## Step 3 — Compose the summary

You already have the KPI values from Step 0's `kpis` object. The
document supplies:

- `headline` — verdict-style, from the release's tone.
  **No digits** (validator enforces this).
- `summary_short` — 1–2 sentences, MUST contain ≥1 number.
- `summary_long` — ≤120 words. Drivers + guidance change +
  balance sheet. No filler.
- `confidence_notes` — restatements, C1-vs-AISC quirks, by-product
  netting, streaming/royalty distortions, currency-translation
  quirks. Empty string if nothing to note.

Deltas per KPI:

- **q/q** — from `kpis[k].prior_qq`.
- **y/y** — from `kpis[k].prior_yy`.
- **vs guidance** — only if the release explicitly gives a
  guidance range for this metric AND you can identify the
  midpoint from the fetched document. Use the midpoint.
- **none** — first-print or non-comparable metric.
- **NEVER "vs consensus".**

Miner-specific rules (Hudbay, Capstone, Taseko, Century, etc.):

- Segregate **C1 cash cost** from **AISC**. Never conflate.
- Note by-product netting on cost figures.
- Streaming / royalty distortions — split streamed vs
  non-streamed if the release provides it.

Write the JSON to
`data/summaries/<TICKER_slug>_<PERIOD_slug>.json` — the resolver's
`summaryPath` field is that exact target path. Schema in
`data/summaries-schema.json`.

## Step 4 — Validate + commit + push

1. `Bash: node scripts/validate.js data/summaries/<file>.json` —
   fix reported errors and re-run. Then `node scripts/test-standing.mjs`.
   Both must be green before commit.
2. `git add data/summaries/`,
   commit `earnings: <TICKER> <PERIOD>`, push.
3. Print exactly one of:
   - `RESULT: committed <filename>`
   - `RESULT: skipped — <reason>`
   No other closing line.

## Failure modes — abort, don't paper over

- **Resolver exits 2** — ticker unknown or period not in shard.
  `RESULT: skipped — <resolver message>`.
- **Already-valid summary** — `summaryReady === true`.
  `RESULT: skipped — already exists`.
- **Source unreachable** — 2 searches + 3 fetches exhausted with
  no non-aggregator document loaded.
  `RESULT: skipped — source unreachable, <detail>`.
- **Tooling gap** — you need an operation with no sanctioned
  script. `RESULT: skipped — tooling gap: <describe>`. Do not
  reach for `node -e` or `python3`.
- **Ledger inconsistency** — release publishes figures that
  don't reconcile. Note in `confidence_notes`, don't massage.
- **Validator failure after retry** — if a schema violation
  can't be fixed without inventing data,
  `RESULT: skipped — <specific validator error>`.
