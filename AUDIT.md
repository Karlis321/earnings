# Audit report

Snapshot of the repo state after the rebrand + folder reorganization +
auth/Cloudflare removal. Ran against the original PRDs.

## 1. Folder structure — clean ✓

```
earnings_dashboard/
├── README.md                          top-level overview
├── CLAUDE.md                          agent guide (rewritten for current state)
├── DEPLOY.md                          Vercel deployment runbook
├── AUDIT.md                           this file
├── answer.txt                         Karlis's answers (preserved)
├── prompt1.txt                        original wire-up prompt (preserved)
├── .gitignore
├── .git/
│
├── frontend/                          Next.js 15 App Router — the app
│   ├── app/                           11 routes (login deleted)
│   ├── components/                    admin, event, overview, primitives (25),
│   │                                  security, shell, viewer
│   ├── lib/                           types, fixtures, data seam, formatters
│   ├── providers/                     4 providers (Role deleted)
│   ├── package.json, tsconfig.json, next.config.mjs, postcss.config.mjs,
│   │   vercel.json, .env.example, next-env.d.ts, .next/, node_modules/
│
├── backend/                           README pointer to the spec
│
├── design/                            Signal design system export
│   ├── Signal Design System.dc.html   (rebranded)
│   ├── support.js
│   ├── image-slot.js
│   └── screenshots/                   4 review screenshots
│
└── docs/                              PRDs + plans
    ├── PRD_Project.md                 rebranded, personal-use note added
    ├── PRD_Frontend.md                rebranded, single-user, no auth
    ├── PRD_Backend.md                 fully rewritten to reflect personal use
    ├── Plan_Frontend_Build.md         rebranded
    ├── Plan_WireUp.md                 rebranded, W0 simplified, W5 no CF
    └── reference_mockup.png
```

## 2. What was removed vs the original scope

| Removed | Why |
|---|---|
| `/login` route | No auth per personal-use decision |
| `RoleProvider.tsx` | No editor/readonly split |
| `AdminGuard.tsx` | Admin is always open |
| Header role toggle button + "Editor / Read-only" label | Same |
| Settings "Role" panel | Same |
| Auth env vars (`AUTH_JWT_SECRET`, `AUTH_COOKIE_DOMAIN`, `ENTRA_*`, `SIGNAL_EDITOR_GROUP_ID`) | Same |
| Cloudflare Worker env vars (`TWEET_WORKER_URL`, `TWEET_WORKER_SECRET`) | Vercel-only per DC15 |
| Bloomberg redistribution flag (`RESTRICT_BLOOMBERG_TO_EDITORS`) | Public data only |
| `Design_system/uploads/` (duplicate PRDs) | Redundant |
| `Design_system/.thumbnail` | Preview artifact, not code |
| The `(1)` suffix on PRD filenames | Renamed to canonical `PRD_*.md` / `Plan_*.md` |

## 3. What was rebranded

Everywhere "BluOr" or persona references appeared:

- `PRD_Project.md`: title, exec summary, personas (collapsed to one user
  "Karlis"), §M1 auth notes, User-Agent strings, KPI copy, monetization
  section, future roadmap.
- `PRD_Frontend.md`: title, scope statement, personas, journey J6, login
  view purpose.
- `Plan_Frontend_Build.md`: title.
- `PRD_Backend.md`: fully rewritten §6 auth, §7.3 Cloudflare section, §11
  env manifest, §14 open questions, DC6/DC14/DC15, VerdictNote schema.
- `Plan_WireUp.md`: title, W0 auth phase (Vercel Deployment Protection or
  `ACCESS_CODE`), W5 (no Cloudflare), W8 acceptance (no CIO reference),
  timeline (5–7 → 4–6 weeks).
- `CLAUDE.md`: fully rewritten to reflect current folder structure and
  personal-use scope.
- `DEPLOY.md`: fully rewritten as Vercel personal-account runbook.
- `README.md`: rewritten with new folder layout.
- `frontend/app/layout.tsx`: page title metadata.
- `frontend/components/shell/Header.tsx`: subtitle.
- `frontend/app/login/page.tsx`: deleted entirely.
- `frontend/providers/RoleProvider.tsx`: deleted entirely.
- `frontend/components/admin/AdminGuard.tsx`: deleted entirely.
- `frontend/lib/fixtures/sharedState.ts`: email references.
- `design/Signal Design System.dc.html`: top-bar title + subtitle.

## 4. Deliberate BluOr / Cloudflare / Entra references that remain

These are documentation of what was *removed*, not requirements. Keeping
them makes the change history legible.

- `CLAUDE.md` — "BluOr-internal-tool framing has been rebranded to
  personal-use" (context for future agents).
- `docs/PRD_Backend.md` §6.4 — "What was removed vs earlier drafts" list.
- `docs/PRD_Backend.md` DC15 — "No Cloudflare Worker" decision record.
- `docs/PRD_Backend.md` I10 — struck-through Cloudflare row in the
  integrations table (marks the dropped path).
- `docs/PRD_Project.md` — top-of-doc **Deltas** callout summarizing the
  four rebrand changes. The body of the document (especially Appendix A)
  retains references to the reference codebase's Cloudflare/Nitter path;
  these are historical / reactivation notes, NOT wired into this build.
- `docs/Plan_WireUp.md` W5 — explicit "No Cloudflare Worker in this build"
  note in the scope section.
- `.env.example` in `frontend/` — auth vars removed; the file mentions
  "Vercel Deployment Protection" as the recommended path.
- `answer.txt` — preserved as-is (Karlis's original answers).

Every one of these is intentional context, not a live requirement.

## 5. Build health

From `frontend/`:

- `tsc --noEmit` → **0 errors**.
- `next build` → **11 routes** compiled clean (down from 12; the `/login`
  route was intentionally removed).
- Route sizes unchanged from earlier verification.

## 6. Consistency between docs

Cross-checked the following key claims across documents:

| Claim | PRD_Project | PRD_Backend | Plan_WireUp | CLAUDE.md | Consistent? |
|---|---|---|---|---|---|
| No auth | ✓ (M1 marked N/A) | ✓ (§6) | ✓ (W0 simplified) | ✓ | ✓ |
| Vercel-only, no Cloudflare | ✓ (top note) | ✓ (DC15, §7.3) | ✓ (W5) | ✓ | ✓ |
| $0 budget, LLM OFF | ✓ (§10) | ✓ (DC8) | ✓ (W6 test) | ✓ | ✓ |
| Wire shape collapsed | ✓ (§6 note) | ✓ (DC4, §3.3) | ✓ (W2 risk) | ✓ | ✓ |
| Git-snapshot v1 | ✓ (§6) | ✓ (DC2, §4) | ✓ (W3) | ✓ | ✓ |
| Public URL by design | ✓ | ✓ | — | ✓ | ✓ (WireUp doesn't need to restate) |
| Backfill 3y/8Q default | — | ✓ (DC13, OQ3) | — | — | ⚠ only in Backend PRD (fine — decision lives there) |

## 7. Front-end deltas still required before backend live-mode

Preserved in `PRD_Backend.md §12` — 12 items, mostly small (F1: extend
EarningsSnapshot type to allow ETF variant, F2: currency-mismatch surprise
handling, F3: terminal reaction status, F4: consensus slot, F5–F8: form
gaps in admin, F10–F12: overview + settings polish). F9 (session provider)
struck through since auth is out.

## 8. Known-good starting point

Everything committed to `main` in git. A fresh `npm install && npm run dev`
from `frontend/` boots the app clean. `/gallery` is the fastest way to
review every UI state without navigating fixtures.

## 9. Nothing outstanding for the audit

Would recommend one commit to cement this state before the Vercel deploy.
