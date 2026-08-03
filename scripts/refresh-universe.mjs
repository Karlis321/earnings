#!/usr/bin/env node
/**
 * Universe-wide refresh orchestrator. The permanent successor to the
 * Vercel-Cron / /api/cron/daily route — invoked by
 * .github/workflows/refresh-data.yml on a 06:00 UTC weekday cron.
 *
 * Design principle: this is a THIN orchestrator over the phase scripts
 * that already exist and are individually battle-tested. It does NOT
 * duplicate their internals — it invokes them via child_process so the
 * source of truth for each phase stays in one file.
 *
 * Phase order (as spec'd in prompt1.txt Task 1):
 *   1. yahoo-timeseries ingest (merge/dedup/provenance/currency)
 *   2. quoteSummary + earningsChart pass  (via ingest-eps-estimates)
 *   3. newly-reported detection + promotion (mature-any-reported)
 *   4. SEC-verbatim rederive for touched CIK names (rederive-sec-xbrl,
 *      when the touched-ticker set is non-empty)
 *   5. sec-submissions shells (backfill-sec-submissions-shells)
 *   6. estimates — earningsTrend (ingest-estimates-universe)
 *   7. estimator (run-estimator)
 *   8. reaction maturation + baseline seeding (mature-reactions)
 *   9. market-cap batch (refresh-marketcap — the ported cron-only path)
 *  10. Google News RSS fanout — TODO (see TODO_TOMORROW.md)
 *  11. IR press-release RSS + document sanitization — TODO
 *  12. Sector screen — weekly (Mondays only)
 *  13. Close: shards → events-index → pipeline-report → standing tests
 *  14. Single commit: "daily refresh: <date> — <counts>"
 *
 * CLI:
 *   node scripts/refresh-universe.mjs                # full run
 *   node scripts/refresh-universe.mjs --dry-run      # prints intent per phase
 *   node scripts/refresh-universe.mjs --only=phase-key  # run one phase
 *   node scripts/refresh-universe.mjs --skip=key1,key2  # skip phases
 *   node scripts/refresh-universe.mjs --no-commit    # skip the git commit
 *
 * A phase failure logs ::error but does not abort the run — later
 * phases still attempt. Exit code is nonzero at end when any phase
 * failed. Timeouts and per-request throttling are the phase scripts'
 * own responsibility.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REPORT_PATH = path.join(ROOT, "data", "pipeline-report.json");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const NO_COMMIT = args.includes("--no-commit");
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7) ?? null;
const SKIP = new Set(
  (args.find((a) => a.startsWith("--skip="))?.slice(7) ?? "")
    .split(",")
    .filter(Boolean),
);

const TODAY = new Date();
const TODAY_ISO = TODAY.toISOString().slice(0, 10);
const IS_MONDAY = TODAY.getUTCDay() === 1;

// Each phase names the script relative to scripts/. `optional: true` means
// the script may be missing (Task 1's not-yet-ported paths); we log and
// continue rather than fail the run.
const PHASES = [
  // Prime Yahoo crumb ONCE for the whole orchestrator run + write
  // to /tmp/yahoo-crumb.json. Subsequent Yahoo scripts read from
  // the cache. Reduces the crumb-prime attempts from ~7 to 1 per
  // run — Yahoo was soft-blocking GitHub Actions IPs after rapid
  // retries in the first two failed runs (30795529807, 30797305938).
  { key: "prime-crumb", label: "Prime Yahoo crumb (shared)", script: "prime-yahoo-crumb.mjs" },
  // Auto-resolve edgarCik for entities where it's still undefined.
  // Uses SEC's public ticker→CIK JSON; stamps `null` when the ticker
  // is confirmed not on SEC so future runs don't re-hit the endpoint.
  // Parity with /api/cron/daily's inline resolveEdgarCik loop.
  { key: "resolve-ciks", label: "Auto-resolve missing edgarCik", script: "resolve-missing-ciks.mjs" },
  // Index-membership refresh (optional, deferred). If we want to pick
  // up Wikipedia add/drop revisions automatically each week, the
  // build-sp500-reference + register-sp500-missing sequence can run
  // here (same for R1000). Not wired by default — the Wikipedia
  // reference files are treated as ~quarterly refreshes; running
  // them daily would create noise. To re-sync manually:
  //   node scripts/build-sp500-reference.mjs
  //   node scripts/register-sp500-missing.mjs
  //   node scripts/build-russell1000-reference.mjs   (needs wikipedia html re-fetch)
  //   node scripts/register-russell1000-missing.mjs
  { key: "yahoo-shards", label: "Yahoo fundamentals-timeseries refresh", script: "refresh-yahoo-shards.mjs" },
  { key: "eps-estimates", label: "Yahoo earningsChart estimates", script: "ingest-eps-estimates.mjs" },
  { key: "mature-reported", label: "Newly-reported promotion", script: "mature-any-reported.mjs" },
  { key: "mature-stale", label: "Mature stale upcoming shells", script: "mature-stale-upcoming.mjs" },
  { key: "mature-if-actual", label: "Mature upcoming with actuals present", script: "mature-if-actual-present.mjs" },
  { key: "sec-verbatim", label: "SEC-verbatim rederive (CIK universe)", script: "backfills/rederive-sec-xbrl.mjs", optional: true },
  // sec-shells removed — the backfill script is DEPRECATED (reads/
  // writes the gitignored data/earnings.json monolith). Its function
  // is covered by attach-sec-filings.mjs which stores accession URLs
  // directly on event.sourceLink from SEC submissions endpoint.
  { key: "trend-estimates", label: "Yahoo earningsTrend estimates (upcoming)", script: "ingest-estimates-universe.mjs" },
  { key: "estimator", label: "Median-gap next-event estimator", script: "run-estimator.mjs" },
  { key: "reactions", label: "Reaction maturation + baseline seeding", script: "mature-reactions.mjs" },
  { key: "marketcap", label: "Market-cap + FX batch (Yahoo v7 quote)", script: "refresh-marketcap.mjs" },
  // Google News + wire RSS fanout — ported to
  // scripts/refresh-google-news.mjs on 2026-08-03. Single fetch pass
  // (29 feeds), distributes matched items via displayName / aliases /
  // cashtag string match. Attaches to the same target set as ir-rss.
  { key: "gnews", label: "Google News + wire RSS fanout (29 feeds)", script: "refresh-google-news.mjs" },
  // IR press-release RSS ingest — merges per-ticker OFFICIAL_SOURCES
  // + auto-CIK EDGAR atom feeds into event.sources.items[] on the
  // ticker's latest past event + next upcoming shell, gated to the
  // same [-2,+35] day window as the cron.
  { key: "ir-rss", label: "IR press-release RSS ingest", script: "refresh-ir-rss.mjs" },
  // Sector screen runs weekly only. Wrapped so the orchestrator can
  // skip it cheaply on non-Monday runs without invoking the script.
  { key: "sector-screen", label: "Sector universe expansion (weekly)", script: "backfills/expand-sectors.mjs", optional: true, weeklyOnly: true },
  // Sanitize invariants — parity with sanitizeSnapshot inside the
  // daily-cron mutateEarnings callback. Runs AFTER all ingest so any
  // fresh Yahoo/SEC values that violate an invariant get cleared
  // before the pipeline report reads them. Three sweeps, cheap:
  { key: "sanitize-currency", label: "Currency-unit mismatch sweep", script: "fix-currency-unit-mismatch.mjs" },
  { key: "sanitize-basis", label: "Same-basis surprise sweep (cross-basis clear)", script: "enforce-same-basis-surprise.mjs" },
  { key: "sanitize-absurd", label: "Absurd-surprise floor sweep (>500%)", script: "suppress-absurd-surprise.mjs" },
  { key: "shard-earnings", label: "Rebuild shards + events-index", script: "shard-earnings.mjs" },
  { key: "pipeline-check", label: "Pipeline report + standing invariants", script: "run-pipeline-check.mjs" },
  // Full corruption-test suite — catches invariant regressions before
  // the commit. Goes BEYOND /api/cron/daily which never ran these
  // in-band. If any test fails the run is red but the commit still
  // happens (with FAILED>0 exit code) so we can see what changed.
  { key: "standing-tests", label: "Standing invariant tests (corruption + validate)", script: "test-standing.mjs" },
];

function runNode(scriptRel, extraArgs = []) {
  const scriptPath = path.join(__dirname, scriptRel);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("node", [scriptPath, ...extraArgs], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, durationMs: Date.now() - started });
    });
    child.on("error", (err) => {
      console.error(`::error::spawn failed for ${scriptRel}: ${err.message}`);
      resolve({ code: 1, durationMs: Date.now() - started });
    });
  });
}

async function scriptExists(rel) {
  try {
    await fs.access(path.join(__dirname, rel));
    return true;
  } catch {
    return false;
  }
}

async function marketcapStaleCount() {
  try {
    const reg = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf-8"));
    const staleThresholdIso = new Date(Date.now() - 7 * 86_400_000)
      .toISOString().slice(0, 10);
    let stale = 0;
    let canonical = 0;
    for (const e of reg.entities ?? []) {
      if (!e.isCanonical) continue;
      canonical++;
      const asOf = e.marketCapAsOf ?? "";
      if (!asOf || asOf < staleThresholdIso) stale++;
    }
    return { stale, canonical };
  } catch {
    return { stale: null, canonical: null };
  }
}

async function main() {
  console.log(`::group::refresh-universe · ${TODAY_ISO} · ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  if (ONLY) console.log(`  --only=${ONLY}`);
  if (SKIP.size > 0) console.log(`  --skip=${[...SKIP].join(",")}`);
  console.log(`::endgroup::`);

  const mcBefore = await marketcapStaleCount();
  console.log(
    `marketcap_stale_count (before): ${mcBefore.stale}/${mcBefore.canonical} canonicals`,
  );

  const results = [];
  const startedAt = Date.now();

  for (const phase of PHASES) {
    if (ONLY && phase.key !== ONLY) continue;
    if (SKIP.has(phase.key)) {
      console.log(`::group::skip · ${phase.key}`);
      console.log("  (excluded by --skip)");
      console.log("::endgroup::");
      continue;
    }
    if (phase.weeklyOnly && !IS_MONDAY && !ONLY) {
      console.log(`::group::skip · ${phase.key}`);
      console.log(`  (weekly phase — today is not Monday UTC)`);
      console.log("::endgroup::");
      continue;
    }
    const exists = await scriptExists(phase.script);
    if (!exists) {
      const msg = `  ${phase.script} not found`;
      if (phase.optional) {
        console.log(`::group::skip · ${phase.key} · ${phase.label}`);
        console.log(msg + (phase.todo ? " · TODO — not yet ported from cron route" : ""));
        console.log("::endgroup::");
        results.push({ key: phase.key, status: "skipped-missing" });
        continue;
      }
      console.error(`::error::${phase.key} · ${msg}`);
      results.push({ key: phase.key, status: "missing" });
      continue;
    }

    console.log(`::group::phase · ${phase.key} · ${phase.label}`);
    if (DRY_RUN) {
      console.log(`  DRY RUN — would invoke: node scripts/${phase.script}`);
      results.push({ key: phase.key, status: "dry-run" });
      console.log("::endgroup::");
      continue;
    }

    const { code, durationMs } = await runNode(phase.script);
    if (code === 0) {
      console.log(`  ok · ${(durationMs / 1000).toFixed(1)}s`);
      results.push({ key: phase.key, status: "ok", durationMs });
    } else {
      console.error(`::error::phase ${phase.key} failed with exit ${code}`);
      results.push({ key: phase.key, status: "failed", durationMs, code });
    }
    console.log("::endgroup::");
  }

  const mcAfter = await marketcapStaleCount();
  console.log(
    `marketcap_stale_count (after):  ${mcAfter.stale}/${mcAfter.canonical} canonicals`,
  );

  // Summary
  const totalMs = Date.now() - startedAt;
  const okCount = results.filter((r) => r.status === "ok").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const skippedCount = results.filter(
    (r) => r.status === "skipped-missing" || r.status === "dry-run",
  ).length;
  console.log(`\n=== refresh-universe summary ===`);
  console.log(`  duration: ${(totalMs / 60_000).toFixed(1)} min`);
  console.log(`  ok:       ${okCount}`);
  console.log(`  failed:   ${failedCount}`);
  console.log(`  skipped:  ${skippedCount}`);
  for (const r of results) {
    console.log(
      `  ${r.status === "ok" ? "✓" : r.status === "failed" ? "✗" : "·"}  ${r.key} (${r.status}${
        r.durationMs ? `, ${(r.durationMs / 1000).toFixed(1)}s` : ""
      })`,
    );
  }

  // Read the just-written pipeline-report for headline counts.
  let counts = "";
  let report = null;
  try {
    report = JSON.parse(await fs.readFile(REPORT_PATH, "utf-8"));
    counts = `events=${report.events_total} · past=${report.tickers_with_past_events} · forward=${report.tickers_with_forward_dates} · fresh=${report.freshness?.fresh_pct ?? "?"}% · dupes=${report.duplicates_detected}`;
  } catch {
    counts = "(pipeline-report missing)";
  }

  // Write data/cron-status.json — the same file /admin/health reads
  // for the "cron ran X ago" banner. Parity with /api/cron/daily's
  // writeCronStatus. Rich fields include per-phase timings so the
  // health page can render a run-detail view.
  const finishedAt = new Date();
  const cronStatus = {
    schema: "cron-status/v1",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: totalMs,
    ok: failedCount === 0,
    engines: [],
    events: [],
    totalAppended: 0,
    totalMatured: results.find((r) => r.key === "mature-reported")?.durationMs ? 1 : 0,
    // refresh-universe-native fields (extend cron-status/v1):
    source: "refresh-universe.mjs (GitHub Actions runner)",
    phasesTotal: results.length,
    phasesOk: okCount,
    phasesFailed: failedCount,
    phasesSkipped: skippedCount,
    phaseTimings: results.map((r) => ({
      key: r.key,
      status: r.status,
      durationSec: r.durationMs ? Math.round(r.durationMs / 100) / 10 : null,
    })),
    marketcapStaleBefore: mcBefore.stale,
    marketcapStaleAfter: mcAfter.stale,
    counts,
  };
  const CRON_STATUS_PATH = path.join(ROOT, "data", "cron-status.json");
  await fs.writeFile(CRON_STATUS_PATH, JSON.stringify(cronStatus, null, 2));
  console.log(`\n  ✓ wrote data/cron-status.json`);

  // Commit — only when everything ran and we have changes.
  if (!DRY_RUN && !NO_COMMIT && !ONLY) {
    console.log(`::group::git commit`);
    const { code: statusCode } = await new Promise((r) => {
      const c = spawn("git", ["status", "--porcelain"], { cwd: ROOT, stdio: "inherit" });
      c.on("close", (code) => r({ code: code ?? 1 }));
    });
    // Regardless of git status output, attempt add + commit; the
    // commit will no-op with "nothing to commit" and exit 1, which we
    // tolerate.
    await new Promise((r) => {
      const c = spawn("git", ["add", "data/", "scripts/audits/"], {
        cwd: ROOT,
        stdio: "inherit",
      });
      c.on("close", () => r());
    });
    const msg = `daily refresh: ${TODAY_ISO} — ${counts}`;
    await new Promise((r) => {
      const c = spawn("git", ["commit", "-m", msg], {
        cwd: ROOT,
        stdio: "inherit",
      });
      c.on("close", (code) => {
        if (code === 0) console.log("  committed");
        else console.log("  no changes to commit (or commit failed)");
        r();
      });
    });
    void statusCode;
    console.log("::endgroup::");
  }

  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`::error::orchestrator crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
