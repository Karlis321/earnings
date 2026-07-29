# Deployment runbook

Personal Vercel deployment. Public URL by design ($0 budget, all data
publicly available). No auth wiring.

## Where we are

- Front-end complete, production build passes (`npm run build` in
  `frontend/` → 11 routes, 0 TS errors).
- Backend not implemented yet — the Wire-Up Plan phases it in.
- Fixture-mode is the default; live-mode is gated per-method by
  `FEATURE_FLAGS` in `frontend/lib/flags.ts`.

## Vercel setup — the actual steps

### 1. Push the repo to GitHub

```bash
git remote add origin https://github.com/<you>/earnings-dashboard.git
git push -u origin main
```

Private or public — your call. GitHub Pages isn't involved either way; the
repo is only there for source control and the eventual GitHub Contents API
commit-pipe.

### 2. Import into Vercel

- vercel.com → **Add New Project** → import the GitHub repo.
- On the "Configure Project" screen:
  - **Root Directory:** click **Edit** → set to `frontend`
  - **Framework Preset:** should auto-detect as Next.js after step 1
  - **Build Command:** leave default (`next build`)
  - **Install Command:** leave default (`npm install`)
- **Environment Variables:** leave empty for the initial fixture-mode deploy.
- Click **Deploy**.

First build takes ~2 min. Vercel gives you a `<project>-<hash>.vercel.app`
URL.

### 3. Optional — restrict access

If you want the URL private after all:

- Project → **Settings → Deployment Protection**
- Enable **Vercel Authentication** → Standard Protection
- Only your Vercel account can now access the URL.

## What ships in this "fixture-mode" state

- Overview with 17 seed watchlist rows (edit `frontend/lib/fixtures/registry.ts`
  to swap for your actual tickers).
- Security detail for operating / developer / ETF variants.
- Event detail with reactions, metrics, guidance timeline, sources panel.
- Source viewer with hosted-fallback (mocked) + link-out confirmation.
- Admin surfaces (form validation runs, saves are local-only toasts).
- Component gallery at `/gallery`.
- All three themes (dark / dim / light) toggleable in the header.

No live data ingestion, no writes persist. This is a real production
deployment of the front-end skeleton, ready for the wire-up phases.

## Full backend deploy — later

Purpose: replace fixture data with real, self-refreshing data.

Prereqs:

- [ ] A `GH_PAT` — fine-grained, `Contents: Read & Write` on this repo.

Steps:

1. Add env vars from `frontend/.env.example` — the wire-up is inline
   in the daily cron now; no phased rollout needed for a fresh deploy.
2. `frontend/vercel.json` cron runs Mon–Fri 06:00 UTC. Verify the first cron
   run produces one git commit and populates the Data Status panel.
3. Adjust the entity registry in `data/entity-registry.json` to your
   actual watchlist tickers before backfill.

**Rollback:** Vercel promotes the previous deployment in one click. Because
writes go through git-commit, no state is lost between deploys.

## Verification the build is shippable

From `frontend/`:

```
$ npx tsc --noEmit
(0 errors)

$ next build
Compiled successfully
Generating static pages (11/11)

Route (app)                              Size     First Load JS
┌ ○ /                                    5.2 kB          147 kB
├ ○ /_not-found                          137 B           106 kB
├ ○ /admin                               244 B           146 kB
├ ƒ /admin/entry/[ticker]                1.6 kB          148 kB
├ ○ /admin/feedback                      2.75 kB         152 kB
├ ƒ /admin/securities/[ticker]           141 B           149 kB
├ ○ /admin/securities/new                142 B           149 kB
├ ○ /admin/sources                       3.97 kB         154 kB
├ ○ /gallery                             5.05 kB         150 kB
├ ƒ /s/[ticker]                          13 kB           166 kB
├ ƒ /s/[ticker]/e/[eventId]              4.53 kB         158 kB
├ ○ /sectors                             244 B           146 kB
├ ƒ /sectors/[sectorId]                  239 B           146 kB
└ ○ /settings                            3.42 kB         153 kB
```
