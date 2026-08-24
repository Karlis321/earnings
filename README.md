# Earnings & Catalyst Dashboard

Personal earnings-tracking dashboard for a configurable watchlist and a
wider SP500 ∪ R1000 ∪ core universe. Every number is publicly-sourced
(Yahoo, SEC EDGAR, Google News, IR RSS, FRED), every AI claim is
grounded in a pre-digested on-disk snapshot — never a raw filing.

Design system: **Signal**. Live: `earnings-karlis123.vercel.app`.

---

## What you get

| Route | What it shows |
|---|---|
| `/` | Watchlist overview — reporting picture, framework score chips, freshness state |
| `/s/:ticker` | Security detail: header + sector chips + framework badges + summary panel + past-quarters grid + reaction panel |
| `/s/:ticker/e/:eventId` | Single-event print detail (metrics, guidance, sources, reaction) |
| `/week-ahead` | Upcoming Mon-Fri earnings, commodity strip (8 futures), macro extremity strip (FRED z-scores), + AI-drafted weekly narrative panel |
| `/themes` | Sector-level rollup — 17 mechanical sector cards (median reaction, top movers, headlines) + AI narrative panel (5-8 themes) + family filter chips + cross-sector conviction badges |
| `/screens` | Framework screens — Blue Ocean, Rule Breaker, QARV. Sortable table with per-dimension score bars + delta chips |
| `/correlation` | Pairwise Pearson return-correlation heatmap over the watchlist (6mo daily log returns) |
| `/news` | Cross-ticker news fanout |
| `/settings` | Preferences, data snapshots panel, manual workflow dispatch |
| `/gallery` | Component gallery (every primitive in every state) |

---

## How the AI + data pipeline works

**Two layers, always.**

**Layer 1 — Mechanical (daily 03:00 UTC, Mon-Fri).** `refresh-data.yml`
runs `scripts/refresh-universe.mjs` which walks 28+ phases:
Yahoo-shard ingest → reaction maturation → shard-index rebuild →
market-pulse → macro-signals (FRED z-scores) → sector-signals →
sector-history append → correlations → commodities → QARV screen.
Plain Node. No LLM. Single commit per weekday.

**Layer 2 — LLM narrative** (three workflows, three cadences):
- `sector-ideas.yml` (Sun 21:00 UTC) → drafts 5-8 sector themes from
  `data/sector-signals.json`. Output → `data/sector-ideas.json`.
- `week-ahead.yml` (Sun 22:00 UTC) → drafts the weekly narrative from
  events-index + sector-signals + macro + market-pulse. Output →
  `data/week-ahead-narrative.json`.
- `framework-screen.yml` (1st + 2nd of month 12:00 UTC) → scores 8
  tickers/batch against Blue Ocean or Rule Breaker rubrics. Self-chains
  through the universe until every name has a card ≤ 45 days old.
- `claude-summarize.yml` (nightly + on-demand) → produces
  post-earnings `data/summaries/*.json` for covered names via `/sweep`.

**Trust model** — the LLM never reads raw filings, transcripts, or press
releases. It reads only the pre-digested rollup files. Every citation is
cross-checked by a sanctioned writer script (e.g.
`apply-sector-ideas.mjs`) that rejects any invented ticker, headline,
or number before the file lands on disk. See `CLAUDE.md`'s load-bearing
invariants for the exact contract.

---

## Repo layout

```
earnings_dashboard/
├── README.md              You are here
├── CLAUDE.md              Agent guide + load-bearing invariants (READ FIRST)
├── DEPLOY.md              Vercel deployment runbook
├── prompt1.txt            Working prompt (rewritten each session)
│
├── frontend/              Next.js 15 App Router — the built app
│   ├── app/               Routes + /api handlers
│   ├── components/        UI (SummaryPanel, ThemesView, ScreenTable, …)
│   ├── lib/               Types, format, normalize, sectorFamily, fixtures
│   ├── server/            store (inMemory + gitSnapshot), vendors, pipelineReport
│   └── providers/         React context (theme, persistence, source-viewer)
│
├── scripts/               Active pipeline + validators + AI apply-scripts
│   ├── refresh-universe.mjs        daily 28+ phase orchestrator
│   ├── aggregate-by-sector.mjs     mechanical sector rollup
│   ├── append-sector-history.mjs   daily WoW history append
│   ├── apply-{sector-ideas,week-ahead,screen}.mjs   sanctioned LLM writers
│   ├── refresh-{macro,commodities,correlations,market-pulse}.mjs
│   ├── run-qarv-screen.mjs         mechanical Q/A/R/V screen
│   ├── shard-earnings.mjs · run-pipeline-check.mjs · test-standing.mjs
│   ├── backfills/ · audits/ · dev-tests/ · config/
│   └── (see CLAUDE.md folder-layout for the full inventory)
│
├── data/                  SOURCE OF TRUTH
│   ├── entity-registry.json        every entity we track
│   ├── events/<TICKER>.json        per-ticker shards
│   ├── events-index.json           lightweight cross-ticker grid summary
│   ├── summaries/                  post-earnings /earnings output
│   ├── sector-signals.json         mechanical sector rollup
│   ├── sector-ideas.json           LLM narrative themes
│   ├── sector-history.jsonl        daily WoW medians
│   ├── week-ahead-narrative.json · week-ahead-archive/
│   ├── screens/{blue-ocean,rule-breaker,qarv}.json
│   ├── correlations.json · commodities.json · market-pulse.json · macro-signals.json
│   ├── pipeline-report.json · pipeline-history.json
│   └── documents/                  cached filing bodies
│
├── .claude/commands/      Slash-command procedures (earnings, sweep,
│                          sector-ideas, week-ahead, blue-ocean, rule-breaker)
├── .github/workflows/     GitHub Actions cron + on-demand workflows
├── docs/                  PRDs + audit reports
└── design/                Signal design system export
```

---

## Local development

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

Fixture mode is the default — no env vars required. Everything renders
from `frontend/lib/fixtures/`. Component gallery at `/gallery`.

## Scripts (from `frontend/`)

- `npm run dev` — dev server
- `npm run build` — production build (12 routes)
- `npm run start` — serve production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `next lint`

## Health-check scripts (from repo root)

- `node scripts/test-standing.mjs` — invariant suite + corruption tests + summaries schema validate
- `node scripts/aggregate-by-sector.mjs` — regenerate `data/sector-signals.json`
- `node scripts/run-qarv-screen.mjs` — regenerate `data/screens/qarv.json`

## Deploying

See `DEPLOY.md`. Personal Vercel deploy — set **Root Directory** to
`frontend/` in the Vercel project settings.

## Auth

None. Public URL by design. To gate: enable Vercel Deployment Protection
in the dashboard (zero code), or add a single `ACCESS_CODE` env var.
