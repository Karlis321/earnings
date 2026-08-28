---
name: week-ahead
description: Draft the weekly narrative for /week-ahead. Reads events-index + sector-signals + market-pulse. Output → data/week-ahead-narrative.json.
---

# /week-ahead — weekly earnings + macro narrative

**Purpose:** distill what's coming this trading week into a short,
sourced narrative. Two audiences: (1) the reader who wants a
5-minute daily read on setup + tickers to watch, (2) the reader
who wants "what's on today" context beyond the raw event grid.

Runs daily Mon–Fri 01:30 UTC / 04:30 Latvia summer (right after
/sector-ideas at 01:00 and /audit-daily at 01:15, so this command
can reference today's freshly-committed themes). Writes a single
JSON file
(`data/week-ahead-narrative.json`) — one overwritten record per
run. Rendered as a panel on `/week-ahead`.

Universe scope: displayable operating entities in
SP500 ∪ R1000 ∪ isCore (mirrors the `/week-ahead` view).

**Disclaimer copy** (mandatory, verbatim in the output file):

> AI-drafted week-ahead — not advice, not a recommendation. Data
> grounded in on-disk snapshots; cross-check every claim.

## Step 0 — Snapshot freshness

Load the three inputs. All must exist:

1. `data/events-index.json` — every ticker's `nextScheduled`.
2. `data/sector-signals.json` — sector-level rollup (median reaction,
   top movers, recent news per sector).
3. `data/market-pulse.json` — 4 indices × 3 ranges of bars.

If any of these is missing OR its `generatedAt` (or `updatedAt`) is
more than 3 days old, STOP and emit
`RESULT: skipped — <which file> is stale/missing`. The narrative
gates on fresh data; producing one from a stale snapshot would be
worse than skipping.

**Do NOT use** `data/macro-signals.json` even if present — the
narrative deliberately avoids statistical framing (z-scores,
extremity flags, standard-deviation language). Ground every claim
in observed events + sector medians + index positioning only.

## Step 1 — Compute the week window

`weekOf` = Monday of the upcoming week (find the next Monday from
today's date in UTC). The narrative covers Mon-Fri.

Filter `events-index.json` entries: `nextScheduled` between weekOf
and weekOf+4 days. Restrict to operating entities in
SP500 ∪ R1000 ∪ isCore via entity registry lookup. This is
`eventsCount` for the payload.

## Step 2 — Draft 3 sections

Compose 3 sections (2-5 allowed; 3 is the target). Each section is
80-900 chars. NO forward-looking speculation, NO target prices,
NO macro storytelling that data doesn't support.

**Section 1 — "The setup"** (index backdrop, 3-5 sentences).
Ground in `market-pulse.json`: where the S&P and Nasdaq sit vs
their 1mo range (near highs, mid-range, near lows), and one line
on VIX or Stoxx50 if the movement stands out. No z-scores, no σ
language, no "extremity" framing — just plain observed movement.
End with a one-sentence summary of the week's earnings load
(count + sector concentration from Step 1's filtered pool).

**Section 2 — "What to watch"** (specific events, 3-5 sentences).
Cross-index the eventsCount pool from Step 1 against
`sector-signals.json`:
- For each upcoming event's ticker, look up which sectors it
  belongs to (any sector whose `tickers[]` contains this ticker).
- Prefer tickers reporting in sectors with the strongest recent
  |medianReaction3d| (top-3 sectors by |median|).
- Pick 3-5 events. Name the ticker, day of week, and which sector
  theme it plugs into (e.g., "Wed: HBM US reports into the copper
  cluster, median +6.6% off Q2 prints").
- Diverse day/sector mix over homogeneity.

**Section 3 — "Signals to trust"** (which sector themes carry
weight this week, 1-3 sentences). From `sector-signals.json`
top 3 by |medianReaction3d|:
- Name each sector + its median reaction + ticker count.
- Note whether the news window count is unusually thick (>1000
  items across the sector's tickers is thick).
- Example: "Copper (+6.6% median, 6 tickers, 247 news items) leads
  the reaction table; oil-gas the other way at −2.2% on 33 names."

## Step 3 — Draft 3-8 highlights

Cross-index the eventsCount pool with `sector-signals` sector
membership. Each highlight:

- `ticker`: from events-index (must have `nextScheduled` in the
  weekOf..weekOf+4 window)
- `note`: 20-240 chars. ONE sentence. Cite the ticker's sector
  membership + that sector's median reaction (e.g., "reports into
  copper cluster, median +6.6% off recent Q2 prints — momentum
  read"). No z-score / σ language.
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

`git add data/week-ahead-narrative.json data/sector-signals.json && git commit -m "week-ahead: <weekOf>" && git push origin main`

The `sector-signals.json` add is for consistency with the
sector-ideas fix (see that command's Step 4). The workflow re-runs
`aggregate-by-sector.mjs` before the LLM fires to give it the
freshest input; committing the regenerated snapshot keeps origin
in lockstep with what the narrative was actually validated against.
`git add` on an unchanged file is a no-op.

Standard git allowlist. NO `git init`, NO `git reset --hard`, NO
force-push — the workflow's allowlist blocks these regardless.

## Rules

1. **Data-grounded only.** Every claim in `sections` must be
   defensible from the three input files. If sector medians are
   flat and index positioning is unremarkable, say so plainly —
   don't invent risk factors.
1a. **No statistical framing.** Do not use z-scores, standard
   deviations, σ notation, percentile ranks, "extreme/elevated"
   flags, or any language that implies a statistical test. Cite
   observed values only.
2. **No target prices, no % return forecasts, no directional
   trade calls.** This is context, not signal.
3. **Verbatim disclaimer** — the apply script rejects modifications.
4. **3-8 highlights.** Fewer → skip cleanly ("RESULT: skipped —
   fewer than 3 highlights this week").
5. **Structured, not prose-dumped.** Sections have real headings.
   The UI renders them as separate blocks.

## Fallback

If Step 0 finds stale/missing input, or Step 3 can't defensibly
produce ≥ 3 highlights, exit with
`RESULT: skipped — <one-line reason>`.

The `/week-ahead` view degrades gracefully: absent narrative =
commodity strip + day grid only.

## Result line

Last message must be exactly one of:

- `RESULT: committed data/week-ahead-narrative.json (<N> highlights)`
- `RESULT: skipped — <one-line reason>`
