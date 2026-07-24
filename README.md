# Signal — BluOr Earnings & Catalyst Dashboard

Internal BluOr Asset Management tool. Covers 17 securities with a self-refreshing,
fully-sourced view of each name's earnings/catalyst events, the reaction, and
the commentary around them.

**Status:** front-end complete (fixture-mode). Backend PRD written; backend
implementation follows the wire-up plan.

## Documentation

- **`PRD_Earnings_Catalyst_Dashboard (1).md`** — project PRD (product +
  data + integrations)
- **`FrontEnd_PRD_Earnings_Catalyst_Dashboard (1).md`** — front-end spec
- **`FrontEnd_Build_Plan_Earnings_Catalyst_Dashboard (1).md`** — phased
  front-end build plan
- **`Backend_PRD_Earnings_Catalyst_Dashboard.md`** — backend spec
- **`WireUp_Plan_Earnings_Catalyst_Dashboard.md`** — phased FE↔BE
  integration plan
- **`DEPLOY.md`** — deployment runbook
- **`CLAUDE.md`** — router for future Claude Code sessions
- **`Design_system/`** — Signal design system (tokens, components)

## Toolchain

- Next.js 15 (App Router) + React 19 + TypeScript
- Tailwind CSS v4 with CSS-first design tokens
- IBM Plex Sans + IBM Plex Mono
- Radix UI primitives + lucide-react

## Local development

```bash
npm install
cp .env.example .env.local   # leave blank for fixture-mode
npm run dev                  # http://localhost:3000
```

Fixture mode is the default — no env vars required. Everything renders from
`lib/fixtures/`. The gallery is at `/gallery`.

## Scripts

- `npm run dev` — dev server (fixture-mode by default)
- `npm run build` — production build (verified passing)
- `npm run start` — serve production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `next lint`

## Deploying

See `DEPLOY.md`. In short: the front-end is deployable now as a
fixture-mode preview, but the PRD requires auth gating (§M1) before it can
be exposed publicly. Backend implementation follows the wire-up plan.

## What's in this repo

```
app/                Next.js App Router — every route
  ├─ page.tsx       Watchlist Overview
  ├─ s/[ticker]/    Security Detail (three variants)
  ├─ admin/         Admin surfaces (editor-only)
  ├─ sectors/       Sector view (flagged)
  ├─ login/         Auth stub
  ├─ settings/      Theme, role, feature flags, data status
  └─ gallery/       Component gallery (every state)
components/         Signal primitives + composed views
lib/                Types, fixtures, data seam, formatters, freshness util
providers/          Theme, Role, Persistence, SourceViewer, Toast
Design_system/      Reference for the visual system
```

The `apiClient.ts` seam is where the FE↔BE integration flips per method
(see `WireUp_Plan_*.md`).
