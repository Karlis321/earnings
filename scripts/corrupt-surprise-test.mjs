#!/usr/bin/env node
/**
 * Corruption test for the metrics_surprise_inconsistent counter.
 *
 * Sequence:
 *   1. Baseline — run pipeline check, snapshot the counter.
 *   2. Corrupt — plant a bogus surprisePct (99.99) on a real metric
 *      where actual+estimate exist and the honest math is very
 *      different.
 *   3. Re-check — expect counter to have gone up + reasons[] to
 *      contain the new inconsistency reason.
 *   4. Restore.
 *   5. Final — counter back to baseline.
 *
 *   node scripts/corrupt-surprise-test.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const CHECK = path.join(__dirname, "run-pipeline-check.mjs");

function runCheck(label) {
  const out = execFileSync("node", [CHECK], { encoding: "utf-8" });
  const inconsistentMatch = out.match(/"metrics_surprise_inconsistent":\s*(\d+)/);
  const inconsistent = inconsistentMatch ? Number(inconsistentMatch[1]) : null;
  const reasons = out.match(/"reasons":\s*\[[\s\S]*?\]/)?.[0]?.slice(0, 500) ?? "";
  console.log(`\n=== ${label} ===`);
  console.log("  metrics_surprise_inconsistent = " + inconsistent);
  console.log("  reasons: " + reasons);
  return { inconsistent, reasons };
}

async function main() {
  // Find a shard with a metric that has actual+estimate both set AND
  // a valid surprisePct — we'll corrupt its surprisePct.
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  let target = null;
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const events = Array.isArray(j) ? j : j.events ?? [];
    for (const e of events) {
      if (!e.eventDate) continue;
      for (const m of e.metrics ?? []) {
        if (m.actual?.value != null && m.estimate?.value != null && m.surprisePct != null) {
          target = { path: p, wrapped: !Array.isArray(j), shard: j, events, event: e, metric: m };
          break;
        }
      }
      if (target) break;
    }
    if (target) break;
  }
  if (!target) throw new Error("no metric with actual+estimate+surprisePct found — cannot corrupt");

  console.log(`Target: ${target.event.ticker} · ${target.event.period} · ${target.metric.key}`);
  console.log(`  original: actual=${target.metric.actual.value} · estimate=${target.metric.estimate.value} · surprisePct=${target.metric.surprisePct}`);

  const original = await fs.readFile(target.path, "utf-8");

  // 1. Baseline
  const baseline = runCheck("BASELINE");

  // 2. Corrupt: set surprisePct to a value that can't possibly be right.
  // Real surprise ~= (a-e)/|e|*100. Store 999 which is guaranteed off.
  const originalSurprise = target.metric.surprisePct;
  target.metric.surprisePct = 999.999;
  await fs.writeFile(
    target.path,
    JSON.stringify(target.wrapped ? { ...target.shard, events: target.events } : target.events, null, 2),
  );
  console.log(`\n>>> Corrupted surprisePct: ${originalSurprise} → 999.999`);

  const corrupted = runCheck("AFTER CORRUPTION");

  // 3. Restore
  await fs.writeFile(target.path, original);
  console.log(`\n>>> Restored ${target.event.ticker} shard`);

  const restored = runCheck("AFTER RESTORE");

  // Assertions
  console.log("\n=== RESULT ===");
  console.log(`  baseline counter:          ${baseline.inconsistent}`);
  console.log(`  after-corruption counter:  ${corrupted.inconsistent}`);
  console.log(`  after-restore counter:     ${restored.inconsistent}`);
  const rose = corrupted.inconsistent === baseline.inconsistent + 1;
  const back = restored.inconsistent === baseline.inconsistent;
  const flagged = /metrics_surprise_inconsistent/.test(corrupted.reasons);
  console.log(`  counter increased by 1?    ${rose}`);
  console.log(`  reason cited in reasons[]? ${flagged}`);
  console.log(`  restored to baseline?      ${back}`);
  if (rose && back && flagged) {
    console.log("\n✓ Corruption test PASSED — invariant fires on planted bug + clears on restore.");
    process.exit(0);
  } else {
    console.log("\n✗ Corruption test FAILED.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
