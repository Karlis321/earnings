---
name: audit
description: Read-only full dashboard audit — data correctness, AI grounding, pipeline health, UI wiring. Output → scripts/audits/full-audit-<ISO>.json + markdown summary. Fix nothing.
---

# /audit — Full dashboard audit (evidence-based, deterministic-first)

Read-only audit of data correctness, AI grounding, pipeline health, and UI wiring across the whole universe. **Audit only — fix nothing.** Output evidence + a ranked action list.

## META-RULES (the audit must not hallucinate about itself)
- Every PASS/FAIL cites evidence: file path + field + value (or `MISSING`), or endpoint + status, or workflow run id + timestamp. No "looks fine" without a read value.
- Deterministic-first: the audit runs via `scripts/audits/full-audit.mjs`; report ONLY from its JSON. LLM judgement is used ONLY for the reconcile step (§E/§F), never to assert a value is present/correct.
- Anything unverifiable → `UNVERIFIED — reason`, never a silent pass.
- Type-aware everywhere: `operating | developer | etf`. Never fault a developer for missing EPS/estimates or an ETF for missing events — check the fields the TYPE must have (per `entity-registry.json`).
- Do NOT let the agent write to `data/` or push. Read + compute + report.

## SCOPE
Full universe (SP500 ∪ R1000 ∪ core, ~1,600) from `data/entity-registry.json`. Per-ticker shards `data/events/<TICKER>.json`.

---

## Steps

**Step 1 — Run the deterministic audit script.**

```
Bash: node scripts/audits/full-audit.mjs
```

The script executes these sections on-disk:
- **§D14** — `scripts/test-standing.mjs` (invariants + corruption tests + summaries schema); output captured verbatim.
- **§F17** — trust-model reconcile: for every AI-written file (`sector-ideas.json`, `week-ahead-narrative.json`, `screens/{blue-ocean,rule-breaker}.json`, `summaries/*.json`), each ticker/headline/number is checked against its declared deterministic source. Any orphan → `HALLUCINATION` + which `apply-*.mjs` guard should have caught it.
- **§A** — per-ticker completeness over the universe (base metrics, extended metrics, estimates, dates, reactions, price+mktcap, summary presence). Type-aware.
- **§B** — provenance + staleness spot-checks.
- **§E** — aggregate/derived file integrity (sector-signals, sector-ideas, week-ahead-narrative, commodities, macro-signals, market-pulse, qarv, blue-ocean, rule-breaker, correlations, sector-history, events-index).
- **§F15** — `pipeline-report.json` self-consistency (silent-zero phase detection).
- **§F18** — git integrity (baseline SHA ancestry, orphan history check).

Marked `UNVERIFIED — needs live deploy`, not silently skipped:
- **§C** — source/news preview reachability via `api/documents/proxy`.
- **§G** — endpoint health (`health/debug`, `earnings`, `prices`, `market-pulse`, `documents/proxy`).
- **§F16** — workflow last-run + schedule adherence (GitHub Actions run history).

**Step 2 — Write the JSON + summarize.**

The script writes `scripts/audits/full-audit-<ISO>.json` with:
- per-ticker rows + per-check evidence
- per-file integrity
- per-workflow status
- reconcile results

Then emit a **markdown summary** printed to stdout including:
- X/N fully complete
- failure counts by category
- **hallucination candidates** (source value vs AI value + which guard)
- non-previewable-source tickers
- stale framework cards
- silent-zero phases
- top-10 worst tickers
- **Ranked action list**, highest-impact first, separating **"self-heals next refresh"** (transient SEC, pending horizons, framework-screen not-yet-fired) from **"real bug"** (guard gap, silent-zero phase, matrix NaN, schedule miss).

## Rules

1. **Read-only.** Do NOT write to `data/`. Do NOT commit. Do NOT push.
2. **Type-aware.** Never fault a developer for missing EPS/estimates or an ETF for missing events.
3. **No silent pass.** Every check reports PASS/FAIL/UNVERIFIED with evidence.
4. **Deterministic first.** Report only what the script printed — never assert a value you didn't read.

## Result line

Last message must be exactly one of:

- `RESULT: audited (<N> tickers · <F> failures · <H> hallucination candidates · JSON at scripts/audits/full-audit-<ISO>.json)`
- `RESULT: skipped — <one-line reason>`
