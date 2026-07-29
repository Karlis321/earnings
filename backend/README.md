# Backend

**Not implemented yet.**

The backend spec lives in `../docs/PRD_Backend.md`. The phased implementation
plan lives in `../docs/Plan_WireUp.md`. Nine phases (W0 → W8) — each with an
acceptance checkpoint — build out:

- `app/api/*` Next.js Route Handlers (co-located with the frontend, but
  logically the backend surface).
- `server/store.ts` — repository interface.
- `server/stores/gitSnapshot.ts` — GitHub Contents API commit-pipe (v1 store).
- `data/*.json` — versioned JSON files that ARE the store for v1.
- `scripts/backfills/backfill.mjs` — local one-time seeding.
- `vercel.json` cron config for the daily orchestration.

Since Next.js App Router puts API routes under `app/api/*`, backend code
lives inside `../frontend/` in practice. This `backend/` directory exists as
a placeholder for scripts, docs, and any headless services that grow out of
that (a separate cron worker if we ever move off Vercel Cron, for example).
