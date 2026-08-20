---
name: week-ahead
description: Draft the weekly narrative for /week-ahead. Reads events-index + ranking + macro-signals + market-pulse. Output → data/week-ahead-narrative.json.
---

# /week-ahead — weekly earnings + macro narrative

**Purpose:** distill what's coming this trading week into a short,
sourced narrative. Two audiences: (1) the reader who wants a
5-minute Sunday-evening read on setup + tickers to watch, (2) the
reader Monday morning who wants "what's on today" context beyond
the raw event grid.

Runs Sunday 22:00 UTC. Writes a single JSON file
(`data/week-ahead-narrative.json`) — one overwritten record per
week. Rendered as a panel above the macro strip on `/week-ahead`.

Universe scope: the same SP500 ∪ R1000 ∪ isCore operating set
used by the Ideas leaderboard.

**Disclaimer copy** (mandatory, verbatim in the output file):

> AI-drafted week-ahead — not advice, not a recommendation. Data
> grounded in on-disk snapshots; cross-check every claim.

## Step 0 — Snapshot freshness

Load the four inputs. All must exist:

1. `data/events-index.json` — every ticker's `nextScheduled`.
2. `data/ranking.json` — composite scores + rank.
3. `data/macro-signals.json` — 10 market-priced z-scores.
4. `data/market-pulse.json` — 4 indices × 3 ranges of bars.

If any of these is missing OR its `generatedAt` (or `updatedAt`) is
more than 3 days old, STOP and emit
`RESULT: skipped — <which file> is stale/missing`. The narrative
gates on fresh data; producing one from a stale snapshot would be
worse than skipping.

## Step 1 — Compute the week window

`weekOf` = Monday of the upcoming week (find the next Monday from
today's date in UTC). The narrative covers Mon-Fri.

Filter `events-index.json` entries: `nextScheduled` between weekOf
and weekOf+4 days. Restrict to operating entities in
SP500 ∪ R1000 ∪ isCore (mirror the `/week-ahead` view universe
via entity registry lookup). This is `eventsCount` for the payload.

## Step 2 — Draft 3 sections

Compose 3 sections (2-5 allowed; 3 is the target). Each section is
80-900 chars. NO forward-looking speculation, NO target prices,
NO macro storytelling that data doesn't support.

**Section 1 — "The setup"** (macro backdrop, 3-5 sentences).
Cite specific macro-signals entries. If ANY signal is `flag: "extreme"`
name the series + z-score. If ONLY elevated signals, name the
strongest 2. If everything is normal, say so — "no market-priced
extremity going into the week; the macro chip strip is quiet."
Include one line from `market-pulse.json` on where the S&P (or
Nasdaq) sits over the last 1mo range.

**Section 2 — "What to watch"** (specific events, 3-5 sentences).
Grab the top 3-5 upcoming events by `ranking.compositeScore` (join
events-index nextScheduled tickers against ranking rows). Name the
ticker, the day of the week, and the composite score. Cite ONE
component number per ticker (reaction, surprise, or trend) that
justifies the pick. Prefer tickers whose ticker + day gives a
diverse mix (not all Tuesday).

**Section 3 — "Signals to trust"** (which components carry weight
this week, 1-3 sentences). From `ranking.stats`: which components
have the widest coverage this week? Which is most concentrated on
the tickers reporting? E.g.
"Reaction signal is thick this week (44 of 45 Wed reporters have
a d3 reaction ≥ 90 days matured); surprise is sparse (only 8
tickers carry a clean same-basis surprisePct)."

## Step 3 — Draft 3-8 highlights

Cross-index `ranking.json` top rows with `events-index`
`nextScheduled`. Each highlight:

- `ticker`: from ranking + events-index
- `note`: 20-240 chars. ONE sentence. Cite composite or a
  component number. Optionally note macro alignment (e.g. "reports
  into gold z=+1.4 — extra weight on cost-side commentary").
- `eventDate`: nextScheduled from events-index

**Cross-check:** the apply script rejects any highlight whose
eventDate doesn't match events-index.json. Don't fabricate.

## Step 4 — Persist via the sanctioned script

Write payload to a temp JSON file, then apply:

`Bash: node scripts/apply-week-ahead.mjs <path/to/payload.json>`

Rejects on: bad section length, wrong ticker format, mismatched
eventDate against events-index, missing disclaimer.

Payload envelope:

```
{
  "schema": "week-ahead-narrative/v1",
  "generatedAt": "<current ISO>",
  "weekOf": "<Monday YYYY-MM-DD>",
  "eventsCount": <int>,
  "sections": [ {heading, body}, ... ],
  "highlights": [ {ticker, note, eventDate}, ... ],
  "disclaimer": "AI-drafted week-ahead — not advice, not a recommendation. Data grounded in on-disk snapshots; cross-check every claim."
}
```

## Step 5 — Validate + commit + push

`node scripts/validate.js` — must pass. Then:

`git add data/week-ahead-narrative.json && git commit -m "week-ahead: <weekOf>" && git push origin main`

Standard git allowlist. NO `git init`, NO `git reset --hard`, NO
force-push — the workflow's allowlist blocks these regardless.

## Rules

1. **Data-grounded only.** Every claim in `sections` must be
   defensible from the four input files. If macro-signals is
   quiet, DON'T invent risk factors.
2. **No target prices, no % return forecasts, no directional
   trade calls.** This is context, not signal.
3. **Verbatim disclaimer** — the apply script rejects modifications.
4. **3-8 highlights.** Fewer → skip cleanly ("RESULT: skipped —
   fewer than 3 rankable events this week").
5. **Structured, not prose-dumped.** Sections have real headings.
   The UI renders them as separate blocks.

## Fallback

If Step 0 finds stale/missing input, or Step 3 can't defensibly
produce ≥ 3 highlights, exit with
`RESULT: skipped — <one-line reason>`.

The `/week-ahead` view degrades gracefully: absent narrative =
macro strip + day grid only (same as pre-2F behavior).

## Result line

Last message must be exactly one of:

- `RESULT: committed data/week-ahead-narrative.json (<N> highlights)`
- `RESULT: skipped — <one-line reason>`
