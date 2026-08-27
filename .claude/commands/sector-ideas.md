---
name: sector-ideas
description: Draft 5-8 sector-level narrative themes on top of the mechanical sector-signals rollup. Output → data/sector-ideas.json.
---

# /sector-ideas — LLM sector synthesis

**Purpose:** turn the mechanical sector rollup (`data/sector-signals.json`)
into narrative themes a reader can actually parse. The mechanical
layer says "mining +6.62% median, 144 tickers, 2626 news items."
Your job is: which of these are actual themes worth naming, and why?

Runs daily Mon–Fri 01:00 UTC / 04:00 Latvia summer (15 min before /audit-daily so the
audit's §F17 reconcile compares today's ideas against today's
refreshed sector-signals, and 1 hour before /week-ahead so that
command can incorporate any newly-committed themes). Writes
`data/sector-ideas.json` — one overwritten record per run.
Rendered on `/themes` as a panel above the mechanical sector grid.

**Disclaimer copy** (mandatory, verbatim in the output):

> AI-drafted sector themes — not advice, not a recommendation. Every claim is grounded in on-disk sector-signals; cross-check before acting.

## Step 0 — Snapshot freshness

Load `data/sector-signals.json`. If missing OR its `generatedAt` is
more than 3 days old, STOP and emit
`RESULT: skipped — sector-signals stale/missing`. The narrative
gates on fresh data; producing themes from a stale snapshot would
be worse than skipping.

Also confirm the file has ≥ 5 sectors. Fewer is not enough diversity
to draft themes worth reading.

## Step 1 — Pick 5-8 sectors worth naming

From `sector-signals.sectors[]`, prefer sectors that clear either
bar:

- **Strong reaction**: `|medianReaction3d| ≥ 2.0%`
- **Thick news window**: `newsCountAll ≥ 500` (indicates ongoing
  narrative activity even if the reaction hasn't yet)

Pick 5-8 sectors ranked by max(|medianReaction3d|, newsCountAll/100).
Diversify — avoid picking three similar sectors (e.g., don't take
all three of oil-gas, oil-gas-services, natural-gas if they're
saying the same thing). Prefer variety across:
- Direction (positive + negative reactions both represented)
- Family (metals + energy + tech + financials + healthcare, ideally)

If fewer than 5 sectors clear either bar, exit with
`RESULT: skipped — fewer than 5 sectors carry a nameable theme`.

## Step 2 — Draft the theme per sector

For each picked sector, write:

**`thesis` (60-200 chars, ONE sentence)** — the one-line pitch.
Cite the sector by name + the reaction magnitude. Examples:
- "Copper miners rallying — 6-ticker cluster up +2.6% median on
  news of grid-buildout policy."
- "Oil-gas selling off ahead of OPEC+ — 33-name cohort down
  −2.2% median as inventories build."

Real thesis, not "sector is doing something." A reader should
finish the thesis knowing what to expect on the sector card.

**`rationale` (200-600 chars, 2-4 sentences)** — the supporting
body. Cite:
- The sector's actual `medianReaction3d`, `tickerCount`, `newsCountAll`.
- 1-2 headline themes from `recentHeadlines` (paraphrase, cite the
  actual ticker in the theme).
- If a top mover reported unusually (large reaction magnitude),
  name it with its `reaction3d`.
- Optional: cross-signal with another sector (e.g., "moves opposite
  to oil-gas this week — real divergence, not correlated risk-off").

NO forward-looking price targets. NO "we think X will happen."
NO invented headlines. If you find yourself paraphrasing a headline
that doesn't exist in the data, don't — pick a different sector.

**`supportingTickers` (3-6 tickers)** — pick from the sector's
`topMovers[]` (already ordered by |reaction3d|), plus optionally
any ticker in the sector's `tickers[]` if it's mentioned in a
headline you're citing. Every ticker MUST appear in the sector's
`tickers[]` array — the apply script rejects any ticker not in
membership.

**`keyHeadlines` (3-5 items)** — pick from the sector's
`recentHeadlines[]`. Every item must be `{ticker, headline, source}`
matching a real headline verbatim. The apply script rejects any
headline whose (ticker, headline) pair isn't in
`recentHeadlines[]`.

## Step 3 — Persist via the sanctioned script

Write payload to a temp JSON file, then apply:

`Bash: node scripts/apply-sector-ideas.mjs <path/to/payload.json>`

The script rejects on:
- Wrong sector (not in sector-signals)
- Duplicate sector
- Thesis/rationale length out of range
- SupportingTicker not in sector.tickers[]
- Headline not in sector.recentHeadlines[]
- Wrong disclaimer
- < 5 or > 8 themes

Payload envelope:

```
{
  "schema": "sector-ideas/v1",
  "generatedAt": "<current ISO>",
  "themes": [
    {
      "sector": "<key from sector-signals>",
      "thesis": "<60-200 chars>",
      "rationale": "<200-600 chars>",
      "supportingTickers": ["<ticker>", ...],
      "keyHeadlines": [{ "ticker": "...", "headline": "...", "source": "..." }, ...]
    },
    ...
  ],
  "disclaimer": "AI-drafted sector themes — not advice, not a recommendation. Every claim is grounded in on-disk sector-signals; cross-check before acting."
}
```

Note: you don't need to fill in `dataPoints` — the apply script
stamps the real values from sector-signals so the UI can't drift
from the source of truth.

## Step 4 — Validate + commit + push

`node scripts/validate.js` — must pass. Then:

`git add data/sector-ideas.json data/sector-signals.json && git commit -m "sector-ideas: <N> themes · <date>" && git push origin main`

The `sector-signals.json` add is **critical**: this workflow's step 1
re-runs `aggregate-by-sector.mjs` to give the LLM the freshest headline
window (30 min newer than what the 03:00 refresh committed). The
freshened signals are the ones we validated against. If we don't
commit them, the next audit-daily run at 06:30 reads the STALE
signals from origin and flags every keyHeadline as a HALLUCINATION
(13 spurious findings on 2026-08-26 — see TODO note). Ship both files.

Standard git allowlist. NO `git init`, NO `git reset --hard`, NO
force-push — the workflow's allowlist blocks these regardless.

## Rules

1. **Data-grounded only.** Every claim in every rationale must be
   defensible from `sector-signals.json`. If a sector's news is
   thin, don't invent a "hot theme" — pick a different sector.
2. **No target prices, no % return forecasts, no directional
   trade calls.** Theme description, not signal.
3. **Verbatim disclaimer** — the apply script rejects modifications.
4. **5-8 themes.** Fewer → skip cleanly ("RESULT: skipped —
   fewer than 5 sectors carry a nameable theme").
5. **No headline invention.** Use only what's in
   `recentHeadlines[]`. Paraphrase in the rationale; cite verbatim
   in `keyHeadlines`.

## Fallback

If Step 0 finds stale/missing input, or Step 1 can't produce
5 clean sectors, exit with `RESULT: skipped — <one-line reason>`.

The `/themes` view degrades gracefully: absent themes = mechanical
sector grid only.

## Result line

Last message must be exactly one of:

- `RESULT: committed data/sector-ideas.json (<N> themes)`
- `RESULT: skipped — <one-line reason>`
