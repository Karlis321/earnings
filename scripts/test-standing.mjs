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

const t0 = Date.now();
const results = [];
// Actually inspect pipeline-report.json.status after the script runs.
// The script exits 0 even when status="degraded" (invariant violations),
// so gating only on exit code hides real regressions. Read the file it
// wrote and fail loudly if status != "ok".
function pipelineCheckAndInspect() {
  const ok = run("Pipeline check", "run-pipeline-check.mjs");
  if (!ok) return false;
  try {
    const report = JSON.parse(
      readFileSync(path.join(__dirname, "..", "data", "pipeline-report.json"), "utf-8"),
    );
    if (report.status !== "ok") {
      console.error(`✗ pipeline-report status="${report.status}" — reasons:`);
      for (const r of report.reasons ?? []) console.error(`    · ${r}`);
      return false;
    }
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
