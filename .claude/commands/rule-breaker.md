---
name: rule-breaker
description: Score N tickers against the Motley Fool Rule Breakers rubric. Output → data/screens/rule-breaker.json (merged per ticker).
---

# /rule-breaker — Motley Fool Rule Breakers screen

**Purpose:** rate a batch of tickers on five Rule Breakers
dimensions. Output persists per company at
`data/screens/rule-breaker.json` and renders on
`/screens?framework=rule-breaker`. Monthly cadence.

**Universe:** operating entities in SP500 ∪ R1000 ∪ isCore.

## The five dimensions (frozen — apply-screen.mjs enforces)

| Key | Label | High score means… |
|---|---|---|
| `top-dog-first-mover` | Top dog + first mover | Visibly dominant leader in an important, emerging industry — not a fast follower. |
| `sustainable-advantage` | Sustainable advantage | Real moat: network effects, IP, cost curves, brand — defensible for 5+ years. |
| `management-backing` | Strong management + backing | Founder-led or mission-aligned leadership; above-average institutional/founder ownership. |
| `consumer-appeal` | Strong consumer appeal | Enthusiastic user base — high NPS, viral distribution, category-defining brand. |
| `overvalued-conventional` | Overvalued (conventional wisdom) | Standard multiples flag "expensive" — Rule Breakers PAYS UP for growth others discount. |

Note on `overvalued-conventional`: this is INVERTED from what a
value investor rates as good. A 90 here means "conventional
finance calls this overvalued" (which is a REQUIRED trait for a
Rule Breaker). Cite the P/E or EV/S multiple + a peer comparison.

Each dimension scores 0-100. Composite = mean.

## Step 0 — Load the batch

Same as blue-ocean.md — the workflow passes you a batch of 6-10
tickers. For each:

1. Read entity registry for displayName + companyId + sectorTags +
   marketCapUsd.
2. Read the latest summary at
   `data/summaries/<TICKER>_<PERIOD>.json` if it exists.
3. Read the shard's latest event for metrics + extendedMetrics.
4. Do 1-3 `WebSearch` calls per ticker on: industry position,
   founder/CEO tenure, insider ownership, valuation multiples vs
   peers. Aggregators + finance portals are fine sources for
   framework judgments.

## Step 1 — Score each dimension

Scoring bands (same as blue-ocean.md):

- **0-20** — anti-Rule-Breaker: mature laggard on this dimension.
- **50** — neutral / mixed evidence.
- **80-100** — textbook Rule Breaker fit.

**Special rule for `overvalued-conventional`:** score HIGH when
the company trades expensive on conventional multiples AND that
premium is what conventional finance dislikes. Score LOW when
the stock trades at trough multiples relative to peers. This
inversion is deliberate — Rule Breakers embraces multiples that
value investors reject.

Rationale (20-280 chars per dimension) must cite a fact — a
percentage, a multiple, a market share number, a founder tenure
year. NO adjectives without numbers.

Example good rationale on `top-dog-first-mover`:
`"~90% share of GPUs sold into AI training clusters (Jensen-led
since 1993; 32-year single-CEO tenure with data-center revenue
growing >100% y/y through 2024)."`

## Step 2 — Verdict

One sentence, 20-320 chars, neutral tone, no trade call. Summarize
the composite. Example:

`"Textbook Rule Breaker composite above 80 — dominant AI-training
share, founder-led, extreme customer stickiness, but the trailing
P/E in the 40s is exactly the premium conventional finance
protests, which is the point."`

## Step 3 — Persist via the sanctioned script

Payload envelope (same shape as blue-ocean, different framework
+ different dimension keys):

```
{
  "screens": [
    {
      "ticker": "NVDA US",
      "companyId": "co-...",
      "displayName": "NVIDIA Corporation",
      "compositeScore": 82.0,
      "dimensions": [
        {"key": "top-dog-first-mover", "score": 95, "rationale": "..."},
        {"key": "sustainable-advantage", "score": 85, "rationale": "..."},
        {"key": "management-backing", "score": 88, "rationale": "..."},
        {"key": "consumer-appeal", "score": 75, "rationale": "..."},
        {"key": "overvalued-conventional", "score": 67, "rationale": "..."}
      ],
      "verdict": "...",
      "sources": [ ... ],
      "screenedAt": "<ISO>"
    },
    ...
  ]
}
```

Persist:

`Bash: node scripts/apply-screen.mjs rule-breaker <path/to/payload.json>`

The script enforces the exact 5 keys above; unknown or missing
keys reject the whole payload.

## Step 4 — Commit + push

`git add data/screens/rule-breaker.json && git commit -m "rule-breaker: <tickers>" && git push origin main`

## Rules

Identical to blue-ocean.md — 6-10 tickers per batch, composite
must equal mean(dimensions), frozen dimension keys, no target
prices, every rationale cites a fact.

Additional rule for this rubric: the `overvalued-conventional`
dimension's directionality can confuse. Double-check: a stock
trading at 8x forward P/E is a LOW score here, not high.

## Fallback

Same as blue-ocean.md.

## Result line

- `RESULT: committed data/screens/rule-breaker.json (<N> tickers)`
- `RESULT: skipped — <one-line reason>`
