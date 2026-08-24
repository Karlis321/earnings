#!/usr/bin/env node
/**
 * Corruption test for the reported_without_document rule (Phase 4).
 *
 * Sequence:
 *   1. Baseline — run pipeline check, snapshot the counter.
 *   2. Corrupt — pick a past event with actuals + a valid filing
 *      sourceLink, replace the sourceLink with kind:"fallback" +
 *      Google search URL (the exact bug the rule catches).
 *   3. Re-check — expect counter to have gone up + reasons[] to
 *      contain reported_without_document.
 *   4. Restore verbatim.
 *   5. Final — counter back to baseline.
 *
 *   node scripts/corrupt-report-attachment-test.mjs
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
  const cMatch = out.match(/"reported_without_document":\s*(\d+)/);
  const count = cMatch ? Number(cMatch[1]) : null;
  const reasons = out.match(/"reasons":\s*\[[\s\S]*?\]/)?.[0]?.slice(0, 800) ?? "";
  console.log(`\n=== ${label} ===`);
  console.log(`  reported_without_document = ${count}`);
  console.log(`  reasons: ${reasons}`);
  return { count, reasons };
}

// Plant N corruptions so the counter safely crosses the invariant's
// threshold (`reported_without_document > 20` per run-pipeline-check).
// Baseline is ~12 post-backfill; adding 10 corruptions lands ~22,
// safely above the alarm floor. Prior version corrupted 1 event —
// only enough when the > 100 threshold was live (baseline ~180).
// Kept in sync with the run-pipeline-check floor.
const CORRUPTIONS_TO_PLANT = 10;

async function main() {
  // Find N past events on US-primary tickers (ends " US") with
  // actuals AND a valid filing sourceLink. The counter's degrade
  // path fires only on US-primary CIK-bearing tickers, so a
  // foreign-listing corruption wouldn't move it (structural bucket).
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json") && f.endsWith("_US.json"));
  const targets = [];
  outer: for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const events = Array.isArray(j) ? j : j.events ?? [];
    for (const e of events) {
      if (!e.eventDate) continue;
      if (!e.ticker || !e.ticker.endsWith(" US")) continue;
      const hasActuals = (e.metrics ?? []).some((m) => m.actual?.value != null);
      if (!hasActuals) continue;
      const link = e.sourceLink;
      if (link && link.kind === "filing" && link.url && !/google\.com\/search/i.test(link.url)) {
        targets.push({ path: p, originalText: null, wrapped: !Array.isArray(j), body: j, event: e });
        if (targets.length >= CORRUPTIONS_TO_PLANT) break outer;
        // Move to next file — one corruption per ticker so the
        // resulting delta is exactly N.
        break;
      }
    }
  }
  if (targets.length < CORRUPTIONS_TO_PLANT) {
    console.log(`only ${targets.length} corruptable events found — need ${CORRUPTIONS_TO_PLANT}. rule may already be violated everywhere`);
    console.log("SKIPPING (baseline already inconsistent — corruption test can't discriminate).");
    process.exit(0);
  }
  // Capture originals BEFORE mutating so restore is exact.
  for (const t of targets) t.originalText = await fs.readFile(t.path, "utf-8");

  console.log(`Targets (${targets.length}):`);
  for (const t of targets) console.log(`  · ${t.event.ticker} ${t.event.period}`);

  const baseline = runCheck("BASELINE");

  // Corrupt each: replace filing sourceLink with a Google search fallback.
  for (const t of targets) {
    t.event.sourceLink = {
      kind: "fallback",
      url: `https://www.google.com/search?q=${encodeURIComponent(t.event.ticker)}+${encodeURIComponent(t.event.period ?? "")}+earnings`,
    };
    await fs.writeFile(
      t.path,
      JSON.stringify(t.wrapped ? t.body : (t.body), null, 2),
    );
  }

  const corrupted = runCheck("AFTER CORRUPTION");

  // Restore all N targets from their captured originals.
  for (const t of targets) await fs.writeFile(t.path, t.originalText);
  const restored = runCheck("AFTER RESTORE");

  console.log(`\n=== RESULT ===`);
  console.log(`  baseline counter:          ${baseline.count}`);
  console.log(`  after-corruption counter:  ${corrupted.count}`);
  console.log(`  after-restore counter:     ${restored.count}`);
  const rose = corrupted.count === baseline.count + CORRUPTIONS_TO_PLANT;
  const back = restored.count === baseline.count;
  const flagged = /reported_without_document/.test(corrupted.reasons);
  console.log(`  counter increased by ${CORRUPTIONS_TO_PLANT}?  ${rose}`);
  console.log(`  reason cited in reasons[]? ${flagged}`);
  console.log(`  restored to baseline?      ${back}`);
  if (rose && back && flagged) {
    console.log(`\n✓ Report-attachment corruption test PASSED.`);
    process.exit(0);
  } else {
    console.log(`\n✗ Report-attachment corruption test FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
