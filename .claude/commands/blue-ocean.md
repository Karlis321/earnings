---
name: blue-ocean
description: Score N tickers against the Blue Ocean value-innovation rubric. Output → data/screens/blue-ocean.json (merged per ticker).
---

# /blue-ocean — Kim & Mauborgne value-innovation screen

**Purpose:** rate a batch of tickers on five Blue Ocean dimensions,
producing a persistent per-company card that a reader can scan on
`/screens?framework=blue-ocean`. Frameworks change slowly per
company — this is a monthly cadence, not weekly.

**Universe:** operating entities in SP500 ∪ R1000 ∪ isCore. The
workflow calls `pick-screen-tickers.mjs` to select the next batch;
you don't pick tickers yourself.

## The five dimensions (frozen — apply-screen.mjs enforces these keys)

| Key | Label | High score means… |
|---|---|---|
| `value-innovation` | Value innovation | Simultaneously drives cost DOWN and buyer value UP. Pure Blue Ocean move. |
| `uncontested-space` | Uncontested market space | Operating in a genuinely new or under-competed space where the rules aren't set. |
| `demand-creation` | New demand creation | Converts non-customers into customers rather than fighting for existing share. |
| `strategic-move` | Distinctive strategic move | One identifiable big move (product, model, geography) defines the moat. |
| `cost-leadership` | Cost + value alignment | Broken the value-cost trade-off via ERRC framework (eliminate/reduce/raise/create). |

Each dimension scores 0-100. Composite = mean of the 5.

## Step 0 — Load the batch

The workflow passes you a batch of 6-10 tickers (via env var or
prompt). For each ticker:

1. Read `data/entity-registry.json` to get displayName + companyId + sectorTags.
2. If a summary exists at `data/summaries/<TICKER>_<PERIOD>.json`,
   read it — the KPI grid + drivers + call snippets are the
   primary factual base.
3. Read the ticker's shard's latest event for extendedMetrics
   (sector KPIs) and metrics (revenue/margin trajectory).
4. Do 1-3 focused `WebSearch` calls on the company's competitive
   positioning + recent strategic moves. Aggregators and portals
   are FINE as sources for framework judgments (unlike the
   `earnings.md` filing-source rule).

## Step 1 — Score each dimension

For every dimension, pick a score in [0, 100] based on the rubric:

- **0-20** — strong negative: company is the opposite of the
  dimension (e.g. commodity player scoring value-innovation).
- **30-45** — mild negative.
- **50** — neutral / ambiguous / mixed evidence.
- **55-70** — mild positive.
- **80-100** — strong positive: textbook Blue Ocean fit.

Write a **rationale** (20-280 chars) per dimension that cites a
FACT. NO speculation. NO adjectives without a number attached.
Example good rationale for AAPL on `strategic-move`:
`"iPhone-as-services-flywheel (Services now 25% of revenue and
70%+ gross margin — a structurally different unit economic than
the hardware base)."`

Example bad rationale (rejected by validator once we can):
`"Apple is a compelling long with strong secular tailwinds."` —
no fact, no number, hype adjective.

## Step 2 — Write the verdict

One sentence, 20-320 chars. Neutral tone. Summarize the composite
score's story. NO target price, NO directional trade call.

Example: `"Value-innovation storefront on hardware pricing that
matches feature commoditization + services flywheel that raises
value without matching cost — a textbook Blue Ocean composite
above 70 despite a mature-industry backdrop."`

## Step 3 — Persist via the sanctioned script

Assemble the batch payload:

```
{
  "screens": [
    {
      "ticker": "AAPL US",
      "companyId": "co-...",
      "displayName": "Apple Inc.",
      "compositeScore": 71.4,
      "dimensions": [
        {"key": "value-innovation", "score": 75, "rationale": "..."},
        {"key": "uncontested-space", "score": 60, "rationale": "..."},
        {"key": "demand-creation", "score": 65, "rationale": "..."},
        {"key": "strategic-move", "score": 85, "rationale": "..."},
        {"key": "cost-leadership", "score": 72, "rationale": "..."}
      ],
      "verdict": "...",
      "sources": [
        {"kind": "summary", "ref": "AAPL US FY2026 Q2"},
        {"kind": "shard", "ref": "AAPL_US.json"}
      ],
      "screenedAt": "<ISO>"
    },
    ...
  ]
}
```

Write to a temp file, then:

`Bash: node scripts/apply-screen.mjs blue-ocean <path/to/payload.json>`

The script validates: composite = mean(dimensions) ±0.5, exact
5 dimension keys matching the frozen set, rationale + verdict
length constraints, ticker format, at least 1 source. Rejects
the whole payload on any error. Merges by ticker into the
existing `data/screens/blue-ocean.json`.

## Step 4 — Commit + push

`git add data/screens/blue-ocean.json && git commit -m "blue-ocean: <tickers>" && git push origin main`

Standard git allowlist. NO `git init`, NO `git reset --hard`, NO
force-push — the workflow's allowlist blocks these regardless.

## Rules

1. **6-10 tickers per batch.** Fewer → skip cleanly with
   `RESULT: skipped — batch too small`.
2. **Composite is a computed field.** Set it correctly; the
   validator rejects a 0.5-away discrepancy.
3. **Frozen dimension keys.** Do not invent new keys or drop any.
   The 5 keys above are the only allowed values.
4. **No target prices, no trade calls, no upgrades/downgrades.**
   This is a rubric card, not sell-side research.
5. **Every rationale + verdict must cite a fact.** No hype
   language.

## Fallback

If Step 0 can't find enough context on a ticker (no summary + no
shard + no useful WebSearch signal), OMIT that ticker from the
payload. Empty payload → `RESULT: skipped — no scoreable tickers
in batch`.

## Result line

Last message must be exactly one of:

- `RESULT: committed data/screens/blue-ocean.json (<N> tickers)`
- `RESULT: skipped — <one-line reason>`
