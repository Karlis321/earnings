#!/usr/bin/env node
/**
 * Standing invariant tests. Runs on demand + on every push to main
 * via .github/workflows/standing-tests.yml. Composes:
 *
 *   1. scripts/run-pipeline-check.mjs — computes pipeline-report from
 *      the current shards; must report status="ok".
 *   2. scripts/corrupt-invariant-test.mjs — plants a divergent value on
 *      one listing, confirms the cross-listing consistency invariant
 *      fires with the company id, restores, re-verifies ok.
 *   3. scripts/validate.js — schema-checks every data/summaries/*.json
 *      against data/summaries-schema.json + enforces filename<->body
 *      consistency + the aggregator blocklist on source_url. Cheap
 *      (no network); catches malformed summaries before they ship.
 *
 * Exit 0 on all pass, 1 on any failure. Prints a one-line summary at
 * the bottom so the harness reads at a glance:
 *
 *   node scripts/test-standing.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run(label, script) {
  const p = path.join(__dirname, script);
  console.log(`\n>>> ${label} (${script}) ...`);
  try {
    execFileSync("node", [p], { stdio: "inherit" });
    return true;
  } catch (e) {
    console.error(`✗ ${label} failed (exit ${e.status ?? "?"})`);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// KNOWN_EXCEPTIONS — the ONLY reasons[] entries that are allowed to
// coexist with a `degraded` pipeline-report status without failing
// the standing suite. Each entry is a substring; a reason line
// PASSES if it starts with any of these prefixes. Any reason NOT in
// this list — new or unrecognized — still FAILS the suite.
//
// Add here ONLY when the underlying gap is:
//   1. Documented (typically in CLAUDE.md + a linked TODO),
//   2. Structural (cannot self-heal via daily refresh),
//   3. Safe (the gap is bounded + does not propagate).
//
// Each entry MUST carry a TODO with the removal-condition. When the
// backfill lands + the reason disappears from live reports, drop
// the entry so unrecognized future reasons fail as intended.
// ────────────────────────────────────────────────────────────────
const KNOWN_EXCEPTIONS = [
  // 182 past events with actuals ingested from Yahoo but no filing
  // sourceLink. Structural — the daily refresh cannot retroactively
  // find filings for old events. Requires a deliberate backfill
  // that probes each issuer's IR page + EDGAR CIK for a matching
  // filing per eventDate. Documented in CLAUDE.md load-bearing
  // invariants + on pipeline-report.reasons[] verbatim.
  // TODO: remove this entry once scripts/backfills/backfill-report-
  //       attachments.mjs lands (or equivalent) and the reason no
  //       longer appears in a green refresh run.
  "reported_without_document",
];

function reasonAllowed(reason) {
  return KNOWN_EXCEPTIONS.some((prefix) => reason.startsWith(prefix));
}

const t0 = Date.now();
const results = [];
// Actually inspect pipeline-report.json.status after the script runs.
// The script exits 0 even when status="degraded" (invariant violations),
// so gating only on exit code hides real regressions. Read the file it
// wrote and evaluate:
//   · status="ok"                                   → PASS
//   · status="degraded" AND every reasons[] entry
//     is on the KNOWN_EXCEPTIONS allowlist          → PASS (permitted)
//   · status="degraded" AND ANY reasons[] entry is
//     unrecognized (new/regression)                 → FAIL
//   · status is anything else                       → FAIL
function pipelineCheckAndInspect() {
  const ok = run("Pipeline check", "run-pipeline-check.mjs");
  if (!ok) return false;
  try {
    const report = JSON.parse(
      readFileSync(path.join(__dirname, "..", "data", "pipeline-report.json"), "utf-8"),
    );
    if (report.status === "ok") return true;
    if (report.status !== "degraded") {
      console.error(`✗ pipeline-report status="${report.status}" — unrecognized status`);
      return false;
    }
    const reasons = report.reasons ?? [];
    const unrecognized = reasons.filter((r) => !reasonAllowed(r));
    if (unrecognized.length > 0) {
      console.error(`✗ pipeline-report status="degraded" — unrecognized reason(s):`);
      for (const r of unrecognized) console.error(`    · ${r}`);
      console.error(`  (allowlist: ${KNOWN_EXCEPTIONS.join(", ")})`);
      return false;
    }
    // All reasons on the allowlist — permitted degradation.
    console.log(`✓ pipeline-report status="degraded" — all ${reasons.length} reason(s) on KNOWN_EXCEPTIONS allowlist:`);
    for (const r of reasons) console.log(`    · ${r}`);
    return true;
  } catch (e) {
    console.error(`✗ failed to read pipeline-report.json: ${e.message}`);
    return false;
  }
}
results.push({
  label: "pipeline-report status=ok",
  ok: pipelineCheckAndInspect(),
});
results.push({
  label: "cross-listing invariant fires + clears",
  ok: run("Corruption test", "corrupt-invariant-test.mjs"),
});
results.push({
  label: "surprise-inconsistency invariant fires + clears",
  ok: run("Surprise corruption test", "corrupt-surprise-test.mjs"),
});
results.push({
  label: "freshness.stale>10 invariant fires + clears",
  ok: run("Freshness corruption test", "corrupt-freshness-test.mjs"),
});
results.push({
  label: "news normalizer handles malformed fixture",
  ok: run("News normalizer fixture", "test-news-normalize.mjs"),
});
results.push({
  label: "report-attachment invariant fires + clears",
  ok: run("Report-attachment corruption test", "corrupt-report-attachment-test.mjs"),
});
results.push({
  label: "sp500_complete_pct floor fires + clears",
  ok: run("SP500 completeness corruption test", "corrupt-sp500-completeness-test.mjs"),
});
results.push({
  label: "every index event id resolves in its shard",
  ok: run("Event id integrity", "audit-event-ids.mjs"),
});
results.push({
  label: "summaries validate against schema",
  ok: run("Summary validator", "validate.js"),
});

const durationMs = Date.now() - t0;
const failed = results.filter((r) => !r.ok);
console.log(`\n===============================`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"}  ${r.label}`);
console.log(`Elapsed: ${(durationMs / 1000).toFixed(1)}s`);
if (failed.length > 0) {
  console.log(`\n✗ ${failed.length} test(s) failed`);
  process.exit(1);
}
console.log(`\n✓ all standing tests passed`);
