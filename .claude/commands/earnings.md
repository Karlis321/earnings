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
- `scripts/resolve-edgar-exhibit.mjs <8-K-url>` — given a filing
  URL that points at the 8-K cover document, resolves to the EX-99.1
  press-release exhibit URL (prints one line to stdout). Use this
  BEFORE fetch-edgar whenever the sourceLink URL looks like a bare
  8-K cover — it converts an index-page-then-guess-exhibit dance
  (2-3 fetches) into one exhibit fetch. Counts as one fetch.
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

## Step 0.5 — Depth decision (filing vs kpi-only)

Every click gets the **filing** path first — a click is deliberate
interest, give the real answer. Auto-fall-back to **kpi-only** ONLY
when filing depth can't be done honestly:

- No `edgarCik` on the resolver output AND no `sourceLink.kind ===
  "filing"`  → the search+fetch budget is likely to burn out on
  unreachable IR pages. Skip Step 1/2 and jump to Step 1B.
- Step 1's search/fetch budget got fully consumed without landing a
  parseable primary. Downgrade to kpi-only rather than
  `RESULT: skipped`.
- The fetched document exists but isn't parseable (extract-doc-text
  produces nothing usable). Downgrade.

In any downgrade path, `confidence_notes` MUST begin with:
`"primary filing unreachable — KPI-only summary from verified shard
data."` — readers must know why filing depth wasn't possible.

**NEVER skip based on shard thinness.** The resolver's `kpis` object
size is not a skip signal — even an empty `kpis` object is fine when
the filing is reachable. Composing a summary from the primary filing
does NOT require pre-populated shard KPIs; the filing itself supplies
the numbers. RESULT: skipped is reserved for two cases only:

1. **Resolver exits 2** (Step 0): unknown ticker or period that
   doesn't exist. The resolver's stderr message becomes the reason.
2. **Summary already exists** for the exact period AND force is off:
   the deployed panel already renders it.

Every other case must produce a summary — either full filing depth
or kpi-only (Step 1B). Kpi-only can source numbers from press-release
snippets, wire-service tables, financial data portals, or the
resolver's `kpis` object — anything sourced counts. Any ticker with
a resolvable `sourceLink.url` MUST fetch that document and compose
from it. Any ticker without a shard sourceLink but with a WebSearch-
discoverable release MUST attempt Rung 4 before falling back to
kpi-only.

## Step 1 — Fetch the primary (source ladder)

Consult sources in this order — WebSearch is the LAST resort, not
the first:

**Rung 1: event-level `sourceLink.kind === "filing"`** — a filing
URL we already observed on this exact event. Use it directly.
**Exhibit-resolution shortcut**: if the URL matches an 8-K cover
document (path shape `/Archives/edgar/data/<CIK>/<accession>/<file>.htm`
where `<file>` is the issuer's 8-K identifier, e.g.
`aapl-20260730.htm`, `abbv-20260808.htm`), FIRST run
`Bash: node scripts/resolve-edgar-exhibit.mjs <sourceLink.url>` to
resolve to the EX-99.1 press-release exhibit URL, THEN fetch-edgar
that. Otherwise you'll waste the fetch on a cover-page stub that
just says "See Exhibit 99.1" and be unable to compose from it. The
resolve script counts as one of your three fetches — it hits EDGAR
once to read the folder index.

**Rung 2: `irSources.reports_page_url`** — the company's stable
per-issuer reports/filings-list page (observed or mechanically
derived). Fetch this page, find the link to the latest quarter's
document on it, fetch that.

**Rung 3: venue URL** — if `irSources.publication_venue === "EDGAR"`
and Rung 2 didn't yield a matching document, hit the EDGAR CIK list
directly and pick the 10-Q / 10-K / 6-K covering the period.

**Rung 4: WebSearch** — final fallback, ONE query:
`"<displayName> <period> results press release"`. Prefer results
on `investors.<company>.com`, `<company>.com`, `sec.gov`, or the
company's IR host. Blocklist (validator will reject the summary):
Yahoo, Reuters aggregator, SeekingAlpha, MarketWatch, CNBC,
Bloomberg, Investing.com, Zacks, Motley Fool, Benzinga.

**Write-back on Rung 4 success:** when WebSearch surfaces a document
we successfully fetched, include an `irSourcesUpdate` field in the
Step-5 summary output — the follow-up merger
`scripts/apply-ir-source-discoveries.mjs` (TODO —
see TODO_TOMORROW.md) will fold these into the registry with
source "observed" so the ladder self-improves.

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

## Step 1B — KPI-only compose (fallback path)

Triggered by Step 0.5's downgrade rules. NO web search, NO document
fetch. The entire summary is composed from `resolve-earnings-target`'s
`kpis` object.

Fields to write:

- `depth: "kpi-only"` (required — see schema).
- `headline` — verdict-style, from the deltas alone. E.g. "Revenue
  growth accelerates, margins compress" (Q1 rev y/y +18% + gross
  margin -140bp). No digits (validator enforces).
- `kpis` — the resolver's `kpis` values, mapped to schema shape.
- `summary_short` — 1–2 sentences, ≥1 number. Every sentence
  traceable to a shard KPI + delta. E.g. "Revenue $2.4B was
  +18% y/y and +6% q/q; net margin fell 240bp y/y."
- `summary_long` — ≤80 words of pure number narrative. Cover:
  top-line delta, margin move (if computable), EPS move,
  cash-position delta if `total_cash_usd_m` is on the shard. No
  drivers, no guidance, no cause reasoning.
- `drivers` — OMIT the field entirely (drivers require reading a
  release; kpi-only forbids that).
- `confidence_notes` — MUST start with the mandatory disclaimer:
  `"KPI-only summary — no filing was read; drivers and guidance not
  assessed."` If downgraded from filing depth, prepend
  `"primary filing unreachable — "` before that sentence.
- `source_url` — the event's `sourceLink.url` when
  `sourceLink.kind === "filing"`, otherwise a Google search URL for
  the ticker + period (the same fallback the frontend uses for
  non-filing events). NEVER an aggregator.

RESULT line: `RESULT: <TICKER> <PERIOD> depth=kpi-only`.

Then jump to Step 4 (validate + commit + push).

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

- `depth: "filing"` (required for filing-depth summaries — see
  schema; distinguishes from the Step 1B kpi-only fallback path).
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

### Drivers — why the numbers moved (v2)

After the KPI section, populate the summary's `drivers` array. This
is the "why" that turns a KPI dump into a research note. Rules:

**HARD RULE** — no macro narratives, no analyst-style theorizing,
no causes the document doesn't state. Every entry is either
`company-disclosed` (the filing/MD&A explicitly states this cause)
or `derived-arithmetic` (pure decomposition from our own data,
e.g. "margin expansion is fully explained by revenue +8% against
flat operating costs"). If the release gives no reason for a
move, the honest driver is `"not explained in the release"` —
write that, mark basis `company-disclosed`, don't fill the gap.

**Extraction procedure.** Locate the MD&A's own explanations via
`Bash: node scripts/extract-doc-text.mjs fetched/<file>
--grep "due to|driven by|partially offset|compared to|as a result
of|attributable to|reflecting"` and map each hit to the KPI it
concerns. Prefer the operations-level pass through Peru / Manitoba
/ British Columbia (miners) or per-segment (non-miners) sections
— those carry the specific causes.

**Miner-specific driver categories** — when the release discloses
any of these for a metric, they belong in `drivers`:

- Head grade changes (Cu / Au / Zn / Mo / Ag %), throughput
  (mill tonnes), and recovery (%). These are almost always the
  first-order drivers of production and unit-cost moves.
- Realized price vs benchmark (e.g. LME copper realized
  $X.XX vs $Y.YY average). If the release breaks out realized
  vs benchmark deltas, capture that as its own driver line for
  revenue.
- By-product credit swings — when the release attributes a C1
  or AISC move to gold / silver / molybdenum credits, that IS
  the driver line for that cost metric.
- Capitalized-vs-expensed stripping — a common cause of
  quarter-over-quarter cost swings that's rarely intuitive
  from the top line. If disclosed, capture as its own driver.

**Length & fidelity.** Each `explanation` ≤ 50 words. Quote nothing
verbatim over 15 words (the validator enforces both). Paraphrase
faithfully — don't compress a cause out of existence. Prefer
short lines over one omnibus paragraph — one driver per metric,
plus one `metric: "overall"` line summarising the release-level
narrative if the CEO/CFO quotes stand alone.

**Metric field.** Must match a `kpi.label` from the same summary,
or the literal string `"overall"` for release-level narrative.
The validator warns on unknown labels — check spelling.

### Guidance — company-issued forward statements

Guidance is what the company *itself* states about the future in
the release / MD&A: production ranges, cost ranges, capex plans,
revenue outlooks. It is never analyst expectations, never derived,
never inferred. It goes on the event's `guidance` array (see
`GuidanceEntry` in `frontend/lib/types.ts` — the shape already
exists). The UI panel only renders when the array is non-empty,
so writing nothing when the release gives no guidance is the
correct behaviour, not an omission.

**Extraction procedure.** Use
`Bash: node scripts/extract-doc-text.mjs fetched/<file>
--grep "guidance|outlook|reaffirm|forecast|expect|target|range"` to
locate the guidance section. For each explicit numeric range or
value the company states as its own forward guidance, capture:

| field | value |
|-------|-------|
| `key` | our internal metric key when known (`revenue_usd_m`, `capex_usd_m`, `production_cu_kt`, `c1_usd_lb`, …) OR a descriptive slug for line items that don't map to an existing metric (e.g. `sustaining_capex_usd_m`) |
| `displayLabel` | human-readable label as the release uses it (e.g. "Copper production", "C1 cash cost") |
| `period` | fiscal period covered (`FY2026`, `H1 2026`, `Q3 2026`) |
| `basis` | short note on scope (`consolidated`, `full-year`, `sustaining-only`) |
| `low` / `high` / `midpoint` | Fact objects with `value`, `unit`, `source: {url: source_url, label: "release · guidance", provenance: "regulatory", locator: <section name>}`, `asOf: reported_at`, `method: "filing_manual"`, `confidence: 0.95` |
| `move` | `"raised"` \| `"lowered"` \| `"held"` \| `"initiated"` \| `"withdrawn"` — only when the release EXPLICITLY says so. Silence about prior guidance is NOT reaffirmation; if the release doesn't state it either way, set `move: null` (schema allows). "Reaffirmed 2026 guidance" → `"held"`. |
| `version` | `1` for a fresh capture (bump on subsequent restatements) |
| `supersededById` | `null` at capture time |

For a single-point value (not a range), set `low === high ===
midpoint`. For a range, populate all three.

**HARD RULES.**

1. Only what the document EXPLICITLY states as company guidance.
   Never analyst expectations. Never inferred trajectories.
2. Ranges verbatim as numbers, in the release's own units. Do
   not compute midpoints if the release gives only endpoints;
   set `midpoint` to null and let the UI compute it if needed
   for display.
3. If the release gives NO guidance for a period, write NOTHING
   into `guidance[]`. Do not populate empty entries. The panel's
   conditional-render logic depends on this.
4. **"Reaffirmed" requires the document to say so.** Silence
   about a prior range is not reaffirmation. If the CEO/CFO
   quote uses "unchanged", "reaffirmed", "on track for" —
   `move: "held"`. Otherwise omit `move`.
5. Where the release explicitly changes a prior range (e.g.
   "raising 2026 capex guidance to $220-240M from $200-220M"),
   set `move: "raised"` (or lowered) and note the prior range
   in the source's `locator` field.

The guidance array lives on the same event JSON as KPIs and
drivers — no separate file. Because the schema for
`data/summaries-schema.json` doesn't currently cover guidance
(summaries are the /earnings artefact; guidance is a shard-side
artefact), you write guidance INTO the event's shard via the
usual `git add data/events/` after summary compose.

Write the JSON to
`data/summaries/<TICKER_slug>_<PERIOD_slug>.json` — the resolver's
`summaryPath` field is that exact target path. Schema in
`data/summaries-schema.json`.

## Step 3b — Extract extended metrics into the shard

**Only when depth === "filing"**. Skip for kpi-only downgrades.

While the primary document is loaded, extract sector-driven
extended metrics (non-GAAP + operational KPIs that Yahoo/SEC
structured feeds don't carry) and write them onto the event's
`extendedMetrics[]` array.

1. Read the target set:
   - Import `extendedMetricsForEntity` from
     `frontend/lib/extendedMetricsRegistry.ts` conceptually — you
     already know the entity's `sectorTags` from Step 0 output.
   - Universal set (applies to every ticker): `capex_total`,
     `capex_adjusted`, `free_cash_flow_mgmt`, `buyback_qtr_usd`,
     `dividend_per_share`, `sale_of_assets_usd`, `eps_non_gaap`,
     `guidance_revenue_next_q`, `guidance_eps_next_q`.
   - Sector-specific set added per sectorTag (mining → C1 cash
     cost / AISC / production; financials → NIM / CET1 / ROTCE;
     software → ARR / NDR / cRPO; etc.). Full definitions in
     `frontend/lib/extendedMetricsRegistry.ts`.

2. For each metric in the set, scan the primary document (already
   in `./fetched/`) for a labeled value. Rules:
   - Numeric-table hit → confidence 0.9-1.0
   - Prose extraction with explicit "$X million" / "N%" callout →
     confidence 0.7-0.9
   - Below 0.7 or requires interpretation/computation → SKIP
   - Guidance metrics (`_next_q`): capture low + high when range;
     midpoint only if single point given
   - No hit → omit the entry (do not write `value: null`)

3. Every stored entry MUST carry:
   ```
   {
     key, label, unit, shape ("point"|"range"), value,
     low?, high?,  // range only
     provenance: "llm_extracted",
     source: { url, section, quote },  // exact filing quote
     extractedAt, confidence
   }
   ```

4. Write the extendedMetrics array back to the event on the
   ticker's shard via a small `node -e` — NO, use the sanctioned
   pattern: append to `data/events/<TICKER_slug>.json` under the
   event object matching Step 0's `resolveEarnings-target` id.

   Sanctioned script for this step:
   `Bash: node scripts/apply-extended-metrics.mjs <TICKER> <PERIOD> <path/to/metrics.json>`
   The script reads the JSON payload, locates the event, sets
   `event.extendedMetrics = [...]`, writes the shard.

5. Extraction is BEST-EFFORT. Empty extendedMetrics array is fine
   if the filing didn't disclose anything from the set. Never
   invent a value — no hit = omit.

## Step 4 — Validate + commit + push

1. `Bash: node scripts/validate.js data/summaries/<file>.json` —
   fix reported errors and re-run. Then `node scripts/test-standing.mjs`.
   Both must be green before commit.
2. Stage everything the run touched:
   - `git add data/summaries/` (the summary JSON — always).
   - `git add data/events/` (only if you populated the target event's
     `guidance` array in Step 3 — otherwise no changes to stage here).
   Commit message: `earnings: <TICKER> <PERIOD>` (with a
   `(+guidance)` suffix if the event shard was modified). Push.
3. Print exactly one of:
   - `RESULT: committed <filename>`
   - `RESULT: skipped — <reason>`
   No other closing line.

## Failure modes — abort, don't paper over

`RESULT: skipped` is reserved for **structural** blockers — cases
where the procedure literally cannot produce a summary. Data
thinness, hard-to-find sources, or foreign-filer quirks do NOT
qualify: for those, downgrade to kpi-only per Step 1B and produce
a summary anyway. The user's expectation is a summary on every
click; skips are the last resort.

Legitimate skips:

- **Resolver exits 2** — ticker unknown or period not in shard.
  `RESULT: skipped — <resolver message>`. No summary possible
  because the target is undefined.
- **Already-valid summary + not force** — `summaryReady === true`
  AND the run is not in force-regenerate mode.
  `RESULT: skipped — already exists`. The dashboard already
  renders a summary for this period.
- **Source unreachable AFTER kpi-only attempted** — 2 searches
  + 3 fetches exhausted with no parseable document AND Step 1B's
  kpi-only fallback also produced nothing (which would only
  happen if the resolver's `kpis` object is truly empty AND
  the ticker has no external number source). `RESULT: skipped —
  source unreachable AND kpi-only fallback empty, <detail>`.
- **Validator failure after retry** — if a schema violation
  can't be fixed without inventing data,
  `RESULT: skipped — <specific validator error>`.

Illegitimate skips (produce a summary instead — kpi-only if needed):

- Shard `kpis` object has few entries — kpi-only fallback still
  works; compose from what's there plus press-release/wire numbers.
- Shard `sourceLink.url` points at a filing form other than
  10-K/10-Q — any filing form is a filing-depth source. Fetch it,
  read what it says, compose.
- Ticker outside the covered tier — the covered-tier gate lives
  on the API, not the /earnings procedure. If /earnings received
  the dispatch, produce a summary.

- **Tooling gap** — you need an operation with no sanctioned
  script. `RESULT: skipped — tooling gap: <describe>`. Do not
  reach for `node -e` or `python3`.
- **Ledger inconsistency** — release publishes figures that
  don't reconcile. Note in `confidence_notes`, don't massage.
