# Consistency audit — post-reorg (2dccbf6)

Generated: 2026-07-29T15:43:31Z

## Critical

1. **Path drift: `scripts/backfill.mjs` referenced but moved to `scripts/backfills/backfill.mjs`** · docs/PRD_Backend.md:813, docs/Plan_WireUp.md:543, backend/README.md:14 · Three files reference the old scripts-root path for a backfill script that was moved into `scripts/backfills/` during the reorg. This breaks any documentation reader trying to follow those instructions literally.

2. **Data drift: EventProvenance enum includes values not in Provenance type** · frontend/lib/types.ts:244-252 · The `EventProvenance` type union includes `"yahoo-timeseries"`, `"sec-xbrl-companyfacts"`, `"sec-submissions"`, and `"fmp"` as event-level sources, but the FactSource-level `Provenance` type (line 31) only has `"regulatory"`, `"ir-page"`, `"wire"`, `"news"`, `"social"`, `"independent"`. These are two different enums serving different purposes (event-level vs fact-level provenance), which is correct by design, but the distinction is not documented in types.ts comments.

## Should-fix

1. **Doc drift: DEPLOY.md references non-existent path** · DEPLOY.md:51, DEPLOY.md:78 · Instructions to "edit `frontend/lib/fixtures/registry.ts`" — while `frontend/lib/fixtures/` exists, no `registry.ts` file is present in that directory. The actual registry is `frontend/lib/fixtures/*` but no `registry.ts` specifically. This would confuse a user following the deployment runbook.

2. **Doc drift: Backfill reference in docs/PRD_Backend.md uses singular script name** · docs/PRD_Backend.md:813 · References `scripts/backfill.mjs` (singular) as a one-time seeding script, but the script was moved to `scripts/backfills/backfill.mjs` during phase 2 of the reorg. The instruction should clarify it's now in the backfills archive or update the path.

3. **Convention drift: .env file not .gitignored** · .env:1 (FMP_API_KEY present) · The .env file with FMP_API_KEY is committed to the repo, which is a credential leakage risk. Should be listed in .gitignore and replaced with .env.example.

4. **Schema documentation gap: EventProvenance vs Provenance distinction unclear** · frontend/lib/types.ts:31-37, 244-252 · Two separate provenance enums (fact-level Provenance for FactSource, event-level EventProvenance for EventRecord) serve different purposes but this is not explained in either type's doc comment. A reader could confuse when to use which.

## Cosmetic

1. **Doc consistency: CLAUDE.md folder layout tree describes `fixtures` but doesn't list `frontend/lib/fixtures/registry.ts` specifically** · CLAUDE.md:27 · The tree describes `lib/` as containing "types, format, metricGroups, fixtures" but doesn't itemize the fixtures directory's contents. When DEPLOY.md references a specific file within it, readers may expect it to be listed.

2. **Doc reference: CLAUDE.md mentions deleted audit files** · CLAUDE.md line in "Load-bearing invariants" section · References "AUDIT.md" which was deleted in this reorg; the content was migrated but the filename no longer exists. This is historical and doesn't break anything, but may confuse searches.

3. **Naming consistency: `test-standing.mjs` vs `run-pipeline-check.mjs` verb prefixes differ** · scripts/test-standing.mjs, scripts/run-pipeline-check.mjs · Inconsistent verb prefixes (`test-` vs `run-`) for similar pipeline scripts. Not breaking, but naming could be more consistent (e.g., `test-pipeline-integrity.mjs` or `run-standing-tests.mjs`).

## Sweep summary

- **(a) Path drift:** 3 findings (scripts/backfill.mjs path errors, doc mismatch)
- **(b) Schema drift:** 2 findings (EventProvenance vs Provenance enum distinction not documented; Deploy doc references missing registry.ts)
- **(c) Convention drift:** 1 finding (.env credential leak)
- **(d) Doc drift:** 3 findings (DEPLOY.md paths, CLAUDE.md historical references, tree accuracy)
- **(e) Dead exports/deps:** 0 findings

**Total: 9 findings (2 critical, 4 should-fix, 3 cosmetic)**

### Top 3 Critical Issues (if any reorg blockers exist)

1. **scripts/backfill.mjs path references across 3 docs** — Will silently break if anyone tries to follow the deployment instructions (DEPLOY.md) or backend PRD docs. These are public-facing documentation paths.

2. **.env file with FMP_API_KEY committed** — Credential leakage risk; if this repo is ever made public or shared, the API key is exposed. Should be in .env.example instead with the actual key in Vercel secrets.

3. **DEPLOY.md references non-existent `frontend/lib/fixtures/registry.ts`** — Users following the deployment guide will not find the file they're instructed to edit, breaking the customization step.
