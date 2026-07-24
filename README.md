# Earnings & Catalyst Dashboard

Personal earnings tracking dashboard. Covers a configurable watchlist with a
self-refreshing, fully-sourced view of each name's earnings/catalyst events,
the reaction, and the commentary around them. All data is publicly available
(Yahoo, EDGAR, Google News, IR RSS, etc.).

Design system: **Signal**.

## Folder layout

```
earnings_dashboard/
├── README.md              You are here
├── CLAUDE.md              Agent guide for future Claude Code sessions
├── DEPLOY.md              Vercel deployment runbook
├── answer.txt             Karlis's answers to the design-decision Q&A
├── prompt1.txt            Original wire-up/deploy prompt
│
├── frontend/              Next.js 15 App Router — the app
│   ├── app/               Routes
│   ├── components/        Signal primitives + composed views
│   ├── lib/               Types, fixtures, data seam, formatters, freshness
│   ├── providers/         Theme, Persistence, SourceViewer, Toast
│   ├── package.json       npm scripts (dev, build, start, typecheck, lint)
│   ├── next.config.mjs
│   ├── tsconfig.json
│   ├── postcss.config.mjs
│   ├── vercel.json        Cron + function config
│   └── .env.example
│
├── backend/               Placeholder — backend not implemented yet.
│   └── README.md          Points to docs/PRD_Backend.md + docs/Plan_WireUp.md
│
├── design/                Signal design system export (tokens, screenshots)
│   ├── Signal Design System.dc.html
│   ├── support.js
│   ├── image-slot.js
│   └── screenshots/
│
└── docs/                  All specs
    ├── PRD_Project.md     Master product PRD
    ├── PRD_Frontend.md    Front-end spec (views, components, journeys)
    ├── PRD_Backend.md     Backend spec (endpoints, schema, integrations)
    ├── Plan_Frontend_Build.md   Phased FE build plan (P0–P12)
    ├── Plan_WireUp.md     Phased FE↔BE integration plan (W0–W8)
    └── reference_mockup.png     Original design reference
```

## Local development

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

Fixture mode is the default — no env vars required. Everything renders from
`frontend/lib/fixtures/`. The component gallery is at `/gallery`.

## Scripts

Run from `frontend/`:

- `npm run dev` — dev server (fixture-mode by default)
- `npm run build` — production build (verified passing, 11 routes)
- `npm run start` — serve production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `next lint`

## Deploying

See `DEPLOY.md`. Personal Vercel deploy — set the **Root Directory** in
Vercel project settings to `frontend/` so it finds `package.json`.

## Auth

None. Public URL by design ($0 budget, all data publicly available). If you
later want to gate the URL, enable Vercel Deployment Protection in the
dashboard (zero code) or add a single `ACCESS_CODE` env var (~30 lines).
