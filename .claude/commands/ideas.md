---
name: ideas
description: Draft 8-12 short investment pitches over the top-ranked names in data/ranking.json. Output → data/ideas.json (overwrites). Consumed by /ideas view.
---

# /ideas — signal-ranked pitch cards over the covered universe

**Purpose:** turn the machine-computed leaderboard (`data/ranking.json`,
Feature 3A) into short, sourced, honest pitch cards. Each pitch is a
distilled read on WHY a ticker earned its rank — grounded in the
KPI shard, the reaction move, the forward trend signal, and the
existing summary text. Never analyst speculation. Never a "target
price". Never a recommendation.

Universe: mirrors ranking.json (SP500 ∪ R1000 ∪ isCore operating).
Target size: **8-12 pitches**. Fewer if the leaderboard's tail
doesn't warrant a real thesis; more (up to 20) if a particular
week has an unusual concentration of high-signal names.

**Disclaimer copy** (mandatory, verbatim in the output file):

> AI research over the covered universe — not advice, not a
> recommendation. Cross-check every claim in the primary source
> before acting.

## Step 0 — Read the ranking + confirm freshness

Load `data/ranking.json`. If `generatedAt` is more than 3 days old,
STOP and report `RESULT: skipped — ranking snapshot is stale
(generatedAt=<iso>). Ask the workflow to run scripts/run-ranking.mjs
first.` Do not draft pitches against a stale leaderboard — the
rank/compositeScore validator on apply-ideas.mjs will reject
them anyway.

Otherwise, pick the top 12 by composite from
`ranking.rows` (already sorted).

## Step 1 — For each candidate, pull the context

For each of the 12, read (in order — stop when you have enough):

1. `data/summaries/<TICKER_slug>_<PERIOD_slug>.json` — the latest
   summary Claude wrote for that ticker. May not exist for every
   candidate; that's OK, note absence.
2. `data/events/<TICKER_slug>.json` — the ticker's shard. Look
   at the latest past event's `reaction.points[]`, `metrics[]`,
   and `extendedMetrics[]`. Look at the next upcoming event's
   `scheduledDate` + `metrics.estimate` values.
3. `data/ranking.json` — the row itself has all three components
   (reaction / surprise / trend) with raw percentages. Cite the
   number, not the tanh score.

Optional (do NOT WebSearch unless the numeric picture is
incomplete): the ticker's press release, IR page, or a recent
wire recap. Every pitch must be defensible from data already on
disk — the AI's job is synthesis, not fresh research.

## Step 2 — Draft the pitch

Compose per ticker:

- **thesis** (≤ 20 words): one line stating the reason to look
  further. Plain English. No adjective-heavy hype
  ("compelling", "attractive", "poised", "positioned"). No
  target price. Example:
  `"Reaccelerating revenue after four quarters of decel; margins
  are inflecting on cost discipline."`
- **rationale** (60-800 chars, 3-5 sentences): grounds the thesis
  in specific numbers loaded in Step 1. Cite at least ONE reaction
  return + ONE metric surprise or trend gap. NO forward-looking
  claims beyond what management stated (which the summary
  already captured). NO macro narrative. Example:
  `"Q2 revenue landed +14% y/y vs. +8% expected (2.1% surprise),
  and the stock's 3-day reaction was +8.4% excess to SPX — the
  market rewrote the growth path. Trend signal is +11.2% on
  next-quarter estimate vs. Q2 actual, aligning analyst
  consensus. Operating margin expanded to 31.4%, above the
  30% guide."`
- **risks** (1-4 bullets): concrete factors that could invalidate
  the thesis. NO generic "market volatility" or "macro
  uncertainty". Cite a real number, a real event, or a real
  competitive threat. Example:
  `["Guidance de-risking Q3 to a "modest sequential decline" —
   the 3.5% growth path assumes it doesn't extend to Q4.",
   "AWS gross margin narrowed 120 bps y/y despite AI infra
   tailwind — pricing power question."]`
- **catalyst** (object with `label` + optional `date`): the next
  event on the ticker's calendar. Usually just
  `{label: "FY2026 Q3 earnings", date: nextScheduled from
  ranking.json}`. If a bigger inflection is public (investor
  day, product launch), use that instead — but the date must
  be defensible from the shard or the summary.
- **sources** (≥ 1): a list of `{kind, ref}` pointers.
  - `{kind: "summary", ref: "AAPL US FY2026 Q2"}` when a summary
    was consulted.
  - `{kind: "shard", ref: "AAPL_US.json"}` when raw metrics
    were the primary support.
  - `{kind: "ranking", ref: "ranking.json"}` always allowed
    when the composite/reaction/trend numbers back the claim.
  - `{kind: "filing", ref: "https://sec.gov/…"}` when the
    primary filing was directly used.

## Step 3 — Persist via the sanctioned script

Write the drafted pitches to a temp JSON file, then apply:

`Bash: node scripts/apply-ideas.mjs <path/to/pitches.json>`

The script validates every field (thesis word count, rationale
length, source shape, and — critically — cross-checks every
`ticker` + `rank` + `compositeScore` against the current
`data/ranking.json`). Rejects the whole payload on any failure.

Payload envelope:

```
{
  "schema": "ideas/v1",
  "generatedAt": "<current ISO datetime>",
  "universe": "<copy from ranking.json>",
  "disclaimer": "AI research over the covered universe — not advice, not a recommendation. Cross-check every claim in the primary source before acting.",
  "pitches": [ IdeaPitch, ... ]
}
```

## Step 4 — Validate + commit

Run `node scripts/validate.js` — must pass. Then:

`git add data/ideas.json && git commit -m "ideas: <top-3 tickers>" && git push origin main`

Use the workflow's git allowlist (identical to claude-summarize.yml).
NO `git init`, NO `git reset --hard`, NO force-push.

## Rules

1. **8-12 pitches per run.** Fewer than 8 → skip (`RESULT: skipped
   — insufficient signal quality across the top-12`). More than 12
   only in rare weeks with unusual concentration.
2. **Verbatim disclaimer.** The `disclaimer` field must contain the
   exact string above. The apply script rejects payloads missing it.
3. **Cite data, not speculation.** Every claim in `rationale` needs
   a number-in-loaded-data backing. The apply script doesn't check
   this (can't), but Karlis will grep for hallucinations.
4. **No target prices, no % return forecasts, no upgrade/downgrade
   language.** These are pitch CARDS, not sell-side notes.
5. **Sources ≥ 1.** Every pitch cites at least one shard/summary/
   ranking pointer.

## Fallback

If Step 0 finds stale ranking, or Step 2 can't defensibly draft ≥ 8
pitches, exit with `RESULT: skipped — <reason>`. The `/ideas` view
falls back to the raw ranking table (Feature 3B) — that's fine.

## Result line

Your last message must be exactly one of:

- `RESULT: committed data/ideas.json (<N> pitches)`
- `RESULT: skipped — <one-line reason>`
