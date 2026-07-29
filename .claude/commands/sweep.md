---
description: Batch-summarize all covered names that reported in the last 5 trading days but have no summary yet
argument-hint: (no args)
---

Nightly / on-demand sweep. Only touches the covered tier
(`data/covered.json`). Uses `data/events/` as the calendar — we have
real report dates now; no separate `calendar.json` needed.

## Procedure

1. **List candidates.** Load `data/covered.json` — that's the covered
   universe (17 names as of shipping). For each ticker:
   - Load its shard `data/events/<TICKER_slug>.json`.
   - Find its **latest past event** (max `eventDate` where
     `eventDate` is set).
   - "Recent" = `eventDate` within the last 5 **trading** days
     (skip Sat/Sun; don't compensate for holidays — 5 trading
     days is a rough window, not a calendar precision).
   - "No summary yet" = no file at
     `data/summaries/<TICKER_slug>_<PERIOD_slug>.json`.
   - Include a ticker only when BOTH conditions hold.

2. **Announce.** Before processing, print:
   ```
   Due:      <ticker> <period>, <ticker> <period>, …
   Skipped:  <n> covered names not due
   ```
   Also list the skipped tickers in a compact one-line summary
   with reason (`stale`, `already-summarized`, or `no-events`).

3. **Nothing due path.** If the due list is empty, print
   `sweep: nothing due` and STOP. Do not create an empty commit.
   Do not push. Exit 0.

4. **Run per-ticker.** For each due ticker, execute the
   `/earnings.md` procedure exactly (resolve, fetch primary,
   extract, write, validate, but SKIP its steps 7-8 —
   commit/push are handled once at the end here).

5. **Validate the batch.** Run `node scripts/validate.js` (no args
   — checks every summary in `data/summaries/`). Fix any failures.
   Also run `node scripts/test-standing.mjs`. Both must be green.

6. **One commit.** `git add data/summaries/`, commit with message
   `earnings sweep: <T1> <P1>, <T2> <P2>, …` (compact list of the
   tickers+periods processed), then push.

7. **Report.** Print processed count, skipped count, commit hash.

## Rules that survive the batching

- Any single ticker's failure (no primary source, aggregator-only
  hit, schema-invalid output) MUST abort that ticker but NOT the
  batch. Log the failure with a one-line reason. The final commit
  contains only the tickers that succeeded end-to-end.
- If EVERY due ticker fails, do not create an empty commit; print
  the failures and exit non-zero so the workflow surfaces them.
- Ledger discipline from `/earnings.md` still applies per ticker.
- Aggregator blocklist still applies (validator will reject).
