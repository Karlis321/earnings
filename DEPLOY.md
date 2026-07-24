# Deployment runbook

## Where we are

- Front-end complete, production build passes (`npm run build` → 11 routes,
  0 TS errors).
- Backend not implemented yet — the Wire-Up Plan phases it in.
- No auth wired — every route is currently reachable without a session.
- Fixture-mode is the default; live-mode is gated per-method by
  `FEATURE_FLAGS` in `lib/flags.ts`.

## What "shipping" means at each stage

There are three meaningful "ships":

- **Preview** — internal fixture-mode demo behind Vercel's built-in access
  control. Safe today. No auth work required. Use to review the FE with
  Toms/CIO before backend is built.
- **Staging** — same as production but on a subdomain, real env vars, real
  data. Cutover target for wire-up phases W1–W7. Requires Entra ID + `GH_PAT`
  provisioned.
- **Production** — the live tool. Only after wire-up phase W8 passes
  (`WireUp_Plan.md`).

**Do not put the fixture-mode app on a public URL.** The PRD (§M1) is
explicit: internal tool → must be gated. Public fixture-mode preview
violates that even if the data isn't real, because the shell + naming +
coverage list is BluOr-internal.

---

## Prerequisites

Before any of the three ships:

- [ ] Vercel account (or another Next.js host — Cloudflare Pages, self-hosted
      Node — the wire-up plan assumes Vercel Cron).
- [ ] Repo hosted on GitHub (the commit-pipe persistence requires it).
- [ ] `GH_PAT` — fine-grained, `Contents: Read & Write` on this repo only.

For staging/production additionally:

- [ ] BluOr IT resolves **OQ1** (confirm Entra ID) and **OQ2** (register
      Enterprise App + provision `Signal-Editor` security group).
- [ ] Cloudflare Worker deployed as the Nitter proxy (owned by BluOr AM CF
      account per OQ4).
- [ ] Optional: TwitterAPI.io account (OQ5), FMP key.
- [ ] Domain / subdomain decided (e.g. `signal.bluor.internal`).

---

## Preview deploy — checklist

Purpose: internal-visible fixture-mode demo. **Vercel Preview Protection
must be enabled** so the URL is not public.

1. Push the repo to GitHub (private).
2. Import into Vercel → **enable Preview Protection**
   (Settings → Deployment Protection → Vercel Authentication).
3. Leave env vars blank — fixture-mode is the default.
4. First deploy will produce a `*.vercel.app` URL protected by Vercel SSO.
5. Share the URL with reviewers.

At this point the app runs on fixtures, no backend calls, no writes persist.
Reviewers can exercise every FE journey.

---

## Staging deploy — checklist

Purpose: cutover target for each wire-up phase. Data flows are real; users
are BluOr-only.

1. Create a Vercel project separate from Preview (or use a "staging" env in
   the same project).
2. Add env vars from `.env.example`. Minimum starter set:
   - `GH_PAT`, `GH_REPO_OWNER`, `GH_REPO_NAME`, `GH_BRANCH=main` — commit-pipe
   - `AUTH_JWT_SECRET` (256-bit random), `AUTH_COOKIE_DOMAIN=<staging host>`
   - `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
     `SIGNAL_EDITOR_GROUP_ID` (from IT)
   - `EDGAR_CONTACT_EMAIL`
   - `CRON_SECRET` (random)
   - `LLM_ENABLED=false`
3. Register the staging URL as a redirect URI on the Entra app.
4. Ship phase-by-phase per `WireUp_Plan.md`. Each phase has a checkpoint;
   do not advance until it passes.
5. `vercel.json` cron is on Mon–Fri 06:00 UTC. Verify the first cron run
   produces one git commit and populates the Data Status panel.

---

## Production deploy — checklist

Only after W8 checkpoint passes:

1. Bind the production domain (e.g. `signal.bluor.internal`) to the Vercel
   project.
2. Update `AUTH_COOKIE_DOMAIN` and the Entra redirect URI to prod.
3. Rotate `AUTH_JWT_SECRET` and `CRON_SECRET` — do not reuse staging secrets.
4. Run one manual `POST /api/cron/daily` before turning on scheduled cron,
   to confirm the store commit lands.
5. Enable Vercel Cron.
6. Announce to Toms + CIO.

**Rollback**: Vercel promotes the previous deployment in one click.
Because writes go through git-commit, no state is lost between deploys.

---

## What to do RIGHT NOW

Nothing that requires shared infrastructure — those items need your account
credentials. You can:

- Push the code to GitHub and open a Preview deployment yourself (steps
  under "Preview deploy" above). The build is verified passing.
- Send OQ1/OQ2 to BluOr IT — the Entra registration is the long pole.
- Rotate a `GH_PAT` in your account settings.

Once IT comes back with the Entra numbers and you've pushed the repo, W0 of
the wire-up plan can start. Ping me with the results and I'll drive the
integration phases.

---

## Verification the build is still shippable

Ran locally on this workstation:

```
$ npx tsc --noEmit
(0 errors)

$ next build
Compiled successfully
Generating static pages (11/11)

Route (app)                              Size     First Load JS
┌ ○ /                                    4.75 kB         146 kB
├ ○ /_not-found                          137 B           106 kB
├ ○ /admin                               244 B           146 kB
├ ƒ /admin/entry/[ticker]                1.35 kB         147 kB
├ ○ /admin/feedback                      863 B           151 kB
├ ƒ /admin/securities/[ticker]           141 B           149 kB
├ ○ /admin/securities/new                143 B           149 kB
├ ○ /admin/sources                       2.22 kB         153 kB
├ ○ /login                               3.34 kB         145 kB
├ ƒ /s/[ticker]                          11.5 kB         166 kB
├ ƒ /s/[ticker]/e/[eventId]              2.9 kB          157 kB
├ ○ /sectors                             244 B           146 kB
├ ƒ /sectors/[sectorId]                  239 B           146 kB
└ ○ /settings                            1.78 kB         152 kB
```

Every route builds. Fixture data compiled in. Ready for Preview.
