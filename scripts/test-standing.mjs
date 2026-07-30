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
results.push({
  label: "pipeline-report status=ok",
  ok: run("Pipeline check", "run-pipeline-check.mjs"),
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
