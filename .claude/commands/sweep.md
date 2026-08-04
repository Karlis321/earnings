---
description: Batch-summarize all covered names that reported in the last 5 trading days but have no summary yet
argument-hint: (no args)
---

Nightly / on-demand sweep. Only touches the covered tier
(`data/covered.json`). Uses `data/events/` as the calendar — no
separate `calendar.json` needed.

**Sanctioned tools (same as /earnings) — HARD.** Every data
operation goes through a script in `scripts/`. Never `node -e`,
`python3`, `wc`, `awk`, `sed`, or any other shell one-liner
improvisation. The CI sandbox blocks most of them and you'll
waste turns on recovery. Sanctioned tools:

- `scripts/resolve-earnings-target.mjs <TICKER> [PERIOD]` — Step-0
  resolver, prints one JSON object.
- `scripts/fetch-edgar.mjs <sec.gov-url> [outfile]` — SEC-compliant
  fetcher; writes to `./fetched/<basename>` by default.
- `scripts/resolve-edgar-exhibit.mjs <8-K-url>` — resolves an 8-K
  cover URL to its EX-99.1 press-release exhibit URL. Use before
  fetch-edgar when the event sourceLink is a bare 8-K cover
  (path ends in `.htm` under an accession folder); avoids burning
  fetches on the cover stub. Prints one URL to stdout.
- `scripts/extract-doc-text.mjs <html-file> [--grep pattern]` —
  HTML → text or targeted grep with 2 lines of context.
- `scripts/validate.js` — schema + filename + aggregator-URL
  check.
- `git *`, `ls *`, `grep *` — read-only probes only.

If a needed operation has no sanctioned script:
`RESULT: skipped — tooling gap: <describe it>` for that ticker
and continue to the next. Do not improvise.

## Procedure

1. **List candidates.** The pre-filter script does the heavy
   lifting — pool the universe, filter to "reported in last 5
   trading days AND no summary yet", cap at LIMIT (default 20)
   sorted by freshest event date. Single call:
     `Bash: node scripts/sweep-target-list.mjs`
   → prints a JSON array of tickers on stdout, already de-duped
   and pre-filtered. Parse and iterate.

   Output size is typically 5-20 tickers/day. Occasional
   overflow (peak earnings weeks) gets processed the following
   day since freshest reports sort first.

   Configuration knobs (env vars, all optional):
   - `SCOPE=all` (default) — full universe ≈ 2,985 operating
     non-dormant non-foreign-primary non-pre-listing entities
   - `SCOPE=indexed` — SP500 + R1000 + covered pool ≈ 1,000
   - `RECENT_DAYS=5` — how far back "recently reported" reaches
   - `LIMIT=20` — hard cap on output size, keeps a single sweep
     within Claude Code's --max-turns 30 budget

   Tier A (covered) is always included regardless of scope.

   For each ticker in the union:
   - Run `Bash: node scripts/resolve-earnings-target.mjs "<ticker>"`
     and parse its JSON. Every gate below reads that JSON — do
     not walk shards manually.
   - "Recent" = `eventDate` within the last 5 **trading** days
     (skip Sat/Sun; don't compensate for holidays — 5 trading
     days is a rough window, not a calendar precision).
   - "No summary yet" = `summaryReady === false` on the
     resolver's JSON (which already runs the validator against
     any existing file — no re-check needed).
   - Include a ticker only when BOTH conditions hold.

2. **Announce.** Before processing, print exactly:
   ```
   Due:      <ticker> <period>, <ticker> <period>, …
   Skipped:  <n> covered names not due
   ```
   Also list the skipped tickers in a compact one-line summary
   with reason: `stale` (report is >5 trading days old),
   `already-summarized`, `no-events` (shard empty),
   `unknown-ticker` (resolver exit 2), or `tooling-gap`.

3. **Nothing due path.** If the due list is empty, print
   `sweep: nothing due` and STOP. Do not create an empty commit.
   Do not push. Do not run standing tests. Exit 0. The final
   `RESULT:` line must be `RESULT: skipped — nothing due`.

4. **Run per-ticker.** For each due ticker, execute the
   `/earnings` procedure exactly — Step 0 (resolver) through
   Step 3 (compose summary + drivers + guidance) AND Step 3b
   (extract extendedMetrics per sector registry). **SKIP the
   per-ticker Step 4** (commit + push per ticker) — commits are
   handled once at the end here.

   **Step 3b is MANDATORY, not optional.** While the filing is
   loaded from Step 2, extract every metric from the sector-
   priority set in `frontend/lib/extendedMetricsRegistry.ts`
   (universal set + sector-specific set matching the entity's
   sectorTags) and call
   `Bash: node scripts/apply-extended-metrics.mjs <TICKER> <PERIOD> <payload.json>`
   with the extracted values. Extraction rules per Step 3b:
   numeric-table hit → confidence 0.9-1.0; explicit prose call-
   out → 0.7-0.9; anything below 0.7 → SKIP. Empty result set is
   ACCEPTABLE (the filing may not disclose sector KPIs); an
   ABSENT call to apply-extended-metrics.mjs is NOT — every
   ticker MUST hit the script at least once, even if only to
   write an empty array. Skipping 3b is a task failure.

   Rationale: the mechanical ingest pipeline never fills sector-
   specific KPIs (production, AISC, NIM, ARR, etc.). /earnings
   Step 3b is the only writer for `event.extendedMetrics[]`. If
   Step 3b is skipped, the whole "industry-specific metrics per
   sector" feature never gets data.

   Per-ticker failure isolation: any single ticker's failure
   (no primary source, aggregator-only hit, schema-invalid
   output, tooling gap) MUST abort THAT ticker but NOT the
   batch. Log the failure with a one-line reason and move on.
   The final commit contains only the tickers that succeeded
   end-to-end.

   Per-ticker budget (from /earnings) is preserved: max 2
   WebSearch + max 3 fetches. That budget resets per ticker.
   Step 3b re-uses the already-fetched filing text (no extra
   fetches). It costs at most a few extraction turns per ticker.

5. **Validate the batch.** Run
   `Bash: node scripts/validate.js` (no args — checks every
   summary in `data/summaries/`). Fix any failures. Then
   `Bash: node scripts/test-standing.mjs`. Both must be green
   before commit.

6. **One commit.** `git add data/summaries/ data/events/` (the
   latter picks up any guidance shard-mutations from Step 4 of
   /earnings). Commit with message
   `earnings sweep: <T1> <P1>, <T2> <P2>, …` (compact list of
   the tickers+periods that succeeded). Push.

7. **Report.** Print exactly:
   - `RESULT: committed <N> summaries: <T1> <P1>, …` when
     ≥1 ticker succeeded, OR
   - `RESULT: skipped — nothing due` when the due list was
     empty, OR
   - `RESULT: skipped — all <N> due tickers failed: <reasons>`
     when every due ticker failed (do NOT create an empty
     commit in this case; exit non-zero so the workflow's
     verify step surfaces the failure).

## Rules that survive the batching

- Ledger discipline from `/earnings` still applies per ticker.
- Aggregator blocklist still applies (validator rejects).
- Drivers array (v2) required per ticker where the release
  states causal language; "not explained in the release" is the
  honest fallback.
- Guidance extraction (also from Step 3 of /earnings): only what
  the document explicitly states; empty guidance array means the
  UI panel skips rendering.
- No `node -e` / `python3` / shell one-liner improvisation. If
  you need an operation with no sanctioned script,
  `RESULT: skipped — tooling gap: <detail>` for that ticker.
