# Vercel Setup Guide

Complete walkthrough for deploying this repo to your personal Vercel account.
Starting from zero. No corporate SSO, no Cloudflare, no auth. Public URL by
design.

## 1. Prep — 5 minutes

**On your machine:**
- Node 20+ installed (check with `node -v`).
- Git installed and configured with your name + email.
- A GitHub account (github.com — free).
- A Vercel account (vercel.com — free "Hobby" tier is enough).

**Verify the app builds locally first.** From this repo:
```bash
cd frontend
npm install
npm run build
```
Expect "Compiled successfully" and 11 routes. If not, don't push yet.

## 2. Push to GitHub — 5 minutes

If this repo isn't already on GitHub:

1. Go to github.com → **New repository** → name it `earnings-dashboard` (or
   whatever) → **Private** is fine; you can make it public later. Do NOT
   check "Initialize with README" — the repo already has one.
2. From this project directory:
   ```bash
   git remote add origin https://github.com/<you>/earnings-dashboard.git
   git branch -M main
   git push -u origin main
   ```
3. Verify the repo shows up in your GitHub with all files.

**Note:** the repo has `node_modules/` inside `frontend/` from the local
build. It's in `.gitignore` so it won't be pushed. If you see it in the
GitHub file list, something is wrong — check `.gitignore` covers
`frontend/node_modules`.

## 3. Import into Vercel — 3 minutes

1. Sign in at **vercel.com**.
2. Dashboard → **Add New...** → **Project**.
3. Under "Import Git Repository" you'll see your GitHub repos. Click
   **Import** next to `earnings-dashboard`.
   - If you don't see it: click **Adjust GitHub App Permissions** and grant
     Vercel access to the repo.
4. On the **Configure Project** screen:

   | Setting | Value |
   |---|---|
   | Project Name | `earnings-dashboard` (or anything) |
   | Framework Preset | should auto-detect as **Next.js** |
   | **Root Directory** | click **Edit** → set to `frontend` |
   | Build Command | leave default (`next build`) |
   | Output Directory | leave default (`.next`) |
   | Install Command | leave default (`npm install`) |
   | Node.js Version | 20.x (default) |

   **The Root Directory step is the critical one.** The repo has the
   Next.js app under `frontend/`, not the repo root. If you skip it, the
   build fails with "package.json not found".

5. **Environment Variables** section: leave empty for the initial
   fixture-mode deploy.
6. Click **Deploy**.

First build takes ~90 seconds. Watch the log — should end with:
```
✓ Compiled successfully
Route (app)                              Size     First Load JS
┌ ○ /                                    5.2 kB          147 kB
...
```

When it finishes, Vercel shows a fireworks screen with your URL:
`earnings-dashboard-<random>.vercel.app`. Click **Visit** to open it.

## 4. What you'll see

The full fixture-mode app:
- Overview with 17 covered names
- Every security detail variant clickable
- Event detail with reactions + sources
- Component gallery at `/gallery`
- Theme cycler in the header (dark → dim → light)

Everything renders from fixtures. Nothing writes anywhere. Nothing calls a
live API. This is **the design shipped as a real production Vercel
deployment**, ready for the backend to fill in behind it later.

## 5. Understanding the Vercel Dashboard

Once your project is deployed, the project dashboard has six main sections
across the top nav. Here's what each does and what you'll actually use:

### **Overview** tab
- Big deploy history — every push to `main` becomes a new production
  deployment. Every push to any other branch becomes a preview deployment
  with its own URL.
- **Production Deployment** card — the live one your URL points to.
- **Latest Deployments** — history. Click any to see its build log, its
  own preview URL, and to **Promote to Production** (instant rollback if
  something breaks).

### **Deployments** tab
- Full list, filterable. Click a deployment to see:
  - **Build Logs** — line-by-line `npm install` + `next build` output.
    Where you go when something fails.
  - **Runtime Logs** — request logs (Function invocations, response codes).
    Available after the app is live.
  - **Source** — the git commit that produced this deployment.

### **Analytics** tab
- Free-tier gives basic Web Analytics — pageviews per route, top referrers,
  device breakdown. Toggle on with one click.
- Speed Insights (also free) gives real-world Core Web Vitals per route.
  Useful once real traffic hits.

### **Speed Insights** tab
- Once enabled, it's LCP / FID / CLS per route with real-user samples.
  Ignore until the app is live.

### **Logs** tab (also called "Observability")
- Live tail of Function logs. When the backend endpoints start existing,
  this is where you see the cron output + any error stack traces.

### **Settings** tab — most useful for us
Sub-sections:

- **General** — Root Directory (set to `frontend`), Node version, build/dev
  commands. Change and redeploy if you need to move things.
- **Domains** — add a custom domain if you have one (`signal.yourdomain.com`
  works fine; free). Vercel handles the certificate automatically.
- **Environment Variables** — where you'll add `GH_PAT`,
  `EDGAR_CONTACT_EMAIL`, `CRON_SECRET` etc. as the backend gets wired up.
  Three scopes: **Development / Preview / Production** — for now set
  everything to **All Environments** unless you need different secrets per
  env.
- **Git** — the connected repo, which branch = production (`main`), which
  branches = preview.
- **Deployment Protection** — this is the "gate the URL" toggle. Off by
  default (public URL, which is what you want). Set to **Standard
  Protection** if you ever want it Vercel-login-only.
- **Cron Jobs** — appears once you have `vercel.json` with a `crons`
  section deployed. Shows the schedule + last run status.

### **Storage** tab
- Vercel offers a few managed data services (Postgres, KV, Blob, Edge
  Config). **You don't need any of them for this build.** The git-snapshot
  store uses GitHub's Contents API, not Vercel storage. Ignore this tab.

## 6. Env vars — how to add them later

When you start wiring the backend (Wire-Up Plan phase W1+), you'll need to
add env vars. Steps:

1. Project → **Settings** → **Environment Variables**.
2. For each var:
   - **Name**: e.g. `GH_PAT`
   - **Value**: the actual token/secret
   - **Environment**: check all three boxes (Development / Preview /
     Production) unless you have a reason to split.
3. Click **Save**.
4. **Redeploy** the current production deployment. Env vars don't apply
   retroactively — Vercel needs to rebuild:
   - Deployments tab → three-dot menu on the current production → **Redeploy**.

**Secrets you'll add in order (per Wire-Up plan):**

| Phase | Var | Notes |
|---|---|---|
| W1 | `EDGAR_CONTACT_EMAIL` | Any real email you own — used in EDGAR User-Agent header. |
| W3 | `GH_PAT` | Fine-grained PAT, `Contents: Read & Write` on this one repo. |
| W3 | `GH_REPO_OWNER`, `GH_REPO_NAME`, `GH_BRANCH` | Where writes commit. `GH_BRANCH=main`. |
| W6 | `CRON_SECRET` | Random 32+ char string. Vercel Cron sends this as bearer auth. |
| optional | `FMP_API_KEY` | Only if you sign up for a free FMP account and want consensus fallback. |
| optional | `TWITTERAPI_IO_KEY` | Only if you decide to pay for X commentary. |
| later | `ANTHROPIC_API_KEY` + `LLM_ENABLED=true` | Only when you want LLM summaries. |

## 7. Custom domain — 5 minutes if you have one

1. Buy a domain (Namecheap, Cloudflare Registrar, etc.) or use one you
   already own.
2. Vercel → project → **Settings → Domains → Add**.
3. Type the domain (e.g. `signal.yourdomain.com`). Vercel tells you which
   DNS record to add.
4. In your DNS provider's dashboard, add the CNAME or A record it shows.
5. Vercel provisions a Let's Encrypt cert automatically (~2 minutes).

The `*.vercel.app` URL keeps working as a fallback.

## 8. Continuous deploy — how it works

Once connected, Vercel watches your GitHub repo:

- **Push to `main`** → new production deployment. Old production stays
  reachable in history; you can promote it back with one click.
- **Push to any other branch** → new preview deployment with its own URL.
- **Open a PR** → Vercel comments on the PR with the preview URL.

There is nothing to configure for this. It just works.

## 9. Cron jobs — how they'll behave later

Once the backend `POST /api/cron/daily` endpoint exists (Wire-Up phase W6):

- `frontend/vercel.json` already declares the schedule: `0 6 * * 1-5`
  (06:00 UTC, Mon–Fri).
- Vercel sends a signed request to `/api/cron/daily` with an
  `Authorization: Bearer $CRON_SECRET` header at that time.
- The endpoint fetches vendors, updates data, commits to GitHub, returns
  a summary.
- Success/failure shows in **Logs**.

Hobby-tier limits: daily crons only (no sub-daily). That's exactly what
this design uses, so no upgrade needed.

## 10. Rollback — how

If a deploy breaks something:

1. Deployments tab.
2. Find the last-good production deployment (has a green checkmark).
3. Three-dot menu → **Promote to Production**.
4. Vercel routes the domain to that deployment in ~5 seconds.

No git revert needed. The old deployment is still there; promoting brings
it back live.

## 11. Costs

Hobby tier ($0/month) covers everything this design needs at your scale:

- **Bandwidth**: 100 GB/month included. This app is tiny (~150 KB JS
  first-load × maybe a few page views per day = negligible).
- **Function executions**: 100 GB-hours/month. Cron once a day, a few
  reads per session — you'll use single-digit percent of the limit.
- **Cron jobs**: 2 included. You only need 1.
- **Custom domain**: free.
- **Deployments**: unlimited.
- **Team members**: 1 (yourself).

The moment this would cost money is if you (a) opened it to hundreds of
users, (b) added Anthropic API calls that pushed API cost, or (c) added
FMP paid tier. None of those apply.

## 12. Troubleshooting

**"Module not found" on first deploy** → Root Directory not set to
`frontend`. Fix in Settings → General.

**Build fails with "npm ERR!"** → check Build Logs for the actual npm
error. Most likely a `package.json` mismatch — try `rm -rf
frontend/node_modules frontend/package-lock.json && npm install` locally,
commit the new lockfile, push again.

**Deployment succeeds but the URL 404s** → the Root Directory is right but
the deploy is looking for pages in the wrong place. Verify the Vercel
build log shows "Compiled successfully" and lists the routes.

**Cron isn't firing** → check Settings → Cron Jobs is enabled. Verify
`vercel.json` is inside `frontend/` (not the repo root). Verify
`CRON_SECRET` env var is set.

**"Function timeout"** → default is 10s on Hobby. `frontend/vercel.json`
already ups the cron to 300s and other endpoints to 60s. If a specific
endpoint times out, add it to the `functions` block.

---

## Fastest path: what to do right now

1. `cd frontend && npm run build` — confirms local build.
2. Push to GitHub.
3. Import to Vercel with **Root Directory = `frontend`**.
4. Click Deploy.
5. Open the URL Vercel gives you.

That's the Preview state — your fixture-mode dashboard is live. Come back
for W1 when you're ready to start wiring the backend.
