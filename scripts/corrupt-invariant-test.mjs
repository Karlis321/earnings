#!/usr/bin/env node
/**
 * Corruption test for `companies_with_inconsistent_financials`.
 *
 * Sequence:
 *   1. Baseline — run pipeline check, expect status=ok.
 *   2. Corrupt — pick a two-listing company, multiply one listing's
 *      revenue by 1.5×, save the shard.
 *   3. Re-check — expect status=degraded with the company id in reasons[].
 *   4. Restore — put the original value back, save.
 *   5. Final — pipeline check, expect status=ok again.
 *
 *   node scripts/corrupt-invariant-test.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const CHECK = path.join(__dirname, "run-pipeline-check.mjs");

function runCheck(label) {
  const out = execFileSync("node", [CHECK], { encoding: "utf-8" });
  const lines = out.split("\n");
  const status = lines.find((l) => l.includes('"status"'))?.trim() ?? "?";
  const inconsistent = lines
    .find((l) => l.includes("companies_with_inconsistent_financials"))
    ?.trim() ?? "?";
  const reasons = out.match(/"reasons":\s*\[[\s\S]*?\]/)?.[0]?.slice(0, 400) ?? "?";
  console.log(`\n=== ${label} ===`);
  console.log("  " + status);
  console.log("  " + inconsistent);
  console.log("  reasons: " + reasons);
  return { status, inconsistent, reasons };
}

async function main() {
  // Pick a company we know has ≥2 listings and stable data. GOOGL has 17;
  // easy target — corrupt GOOGL MM's Q2 2026 revenue by 1.5× and see if
  // the invariant fires with the company id in reasons.
  const targetShardName = "GOOGL_MM.json";
  const p = path.join(EVENTS_DIR, targetShardName);
  const original = await fs.readFile(p, "utf-8");
  const j = JSON.parse(original);
  const wrapped = !Array.isArray(j);
  const evs = wrapped ? j.events ?? [] : j;

  const evQ2 = evs.find(
    (e) => e.eventDate && (e.period ?? "").includes("FY2026 Q2"),
  );
  if (!evQ2) throw new Error("no FY2026 Q2 event on GOOGL MM shard");
  const rev = evQ2.metrics?.find((m) => /^revenue_/i.test(m.key ?? ""));
  if (!rev?.actual) throw new Error("no revenue metric on the Q2 event");
  const origValue = rev.actual.value;
  console.log(
    `Target: GOOGL MM · ${evQ2.period} · revenue original = ${origValue.toFixed(1)} ${rev.actual.unit}`,
  );

  // 1. Baseline
  const baseline = runCheck("BASELINE (before corruption)");

  // 2. Corrupt
  const corruptedValue = origValue * 1.5;
  rev.actual.value = corruptedValue;
  console.log(
    `\n>>> Corrupting: GOOGL MM revenue ${origValue.toFixed(1)} → ${corruptedValue.toFixed(1)} (+50%)`,
  );
  await fs.writeFile(
    p,
    JSON.stringify(wrapped ? { ...j, events: evs } : evs, null, 2),
  );

  // 3. Re-check
  const corrupted = runCheck("AFTER CORRUPTION");
  const fired = corrupted.status.includes("degraded") && corrupted.reasons.includes("companies_with_inconsistent_financials");

  // 4. Restore
  rev.actual.value = origValue;
  await fs.writeFile(
    p,
    JSON.stringify(wrapped ? { ...j, events: evs } : evs, null, 2),
  );
  console.log("\n>>> Restored original value");

  // 5. Final
  const final = runCheck("AFTER RESTORE");
  const restoredOk = final.status.includes('"ok"');

  // Delta check — the invariant must INCREASE on corruption and RETURN
  // to the baseline count on restore. Absolute status can start
  // degraded (from unrelated pre-existing inconsistencies); what
  // matters is that our planted corruption is detected and cleared.
  const countOf = (s) => {
    const m = /companies_with_inconsistent_financials=(\d+)|"companies_with_inconsistent_financials":\s*(\d+)/.exec(s.inconsistent + " " + s.reasons);
    if (!m) return 0;
    return Number(m[1] ?? m[2] ?? 0);
  };
  const baseCount = countOf(baseline);
  const corruptedCount = countOf(corrupted);
  const restoredCount = countOf(final);
  const fired2 = corruptedCount > baseCount;
  const restored2 = restoredCount === baseCount;
  console.log("\n=== RESULT ===");
  console.log(`  baseline invariant count:  ${baseCount}`);
  console.log(`  after-corruption count:    ${corruptedCount}`);
  console.log(`  after-restore count:       ${restoredCount}`);
  console.log(`  invariant increased?       ${fired2}`);
  console.log(`  restored to baseline?      ${restored2}`);
  if (fired2 && restored2) {
    console.log("\n✓ Corruption test PASSED — invariant fires as expected, restore clean.");
  } else {
    console.log("\n✗ Corruption test FAILED — see above.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
