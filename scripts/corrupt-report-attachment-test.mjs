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

async function main() {
  // Find a past event with actuals AND a filing sourceLink to corrupt.
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  let target = null;
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const events = Array.isArray(j) ? j : j.events ?? [];
    for (const e of events) {
      if (!e.eventDate) continue;
      const hasActuals = (e.metrics ?? []).some((m) => m.actual?.value != null);
      if (!hasActuals) continue;
      const link = e.sourceLink;
      if (link && link.kind === "filing" && link.url && !/google\.com\/search/i.test(link.url)) {
        target = { path: p, wrapped: !Array.isArray(j), body: j, event: e };
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    console.log("no past event with actuals + filing sourceLink to corrupt — the rule may already be violated everywhere");
    console.log("SKIPPING (baseline already inconsistent — corruption test can't discriminate).");
    process.exit(0);
  }

  console.log(`Target: ${target.event.ticker} · ${target.event.period}`);
  console.log(`  original sourceLink: ${JSON.stringify(target.event.sourceLink)}`);

  const original = await fs.readFile(target.path, "utf-8");
  const baseline = runCheck("BASELINE");

  // Corrupt: replace filing sourceLink with a Google search fallback.
  target.event.sourceLink = {
    kind: "fallback",
    url: `https://www.google.com/search?q=${encodeURIComponent(target.event.ticker)}+${encodeURIComponent(target.event.period ?? "")}+earnings`,
  };
  await fs.writeFile(
    target.path,
    JSON.stringify(target.wrapped ? target.body : (target.body), null, 2),
  );

  const corrupted = runCheck("AFTER CORRUPTION");

  await fs.writeFile(target.path, original);
  const restored = runCheck("AFTER RESTORE");

  console.log(`\n=== RESULT ===`);
  console.log(`  baseline counter:          ${baseline.count}`);
  console.log(`  after-corruption counter:  ${corrupted.count}`);
  console.log(`  after-restore counter:     ${restored.count}`);
  const rose = corrupted.count === baseline.count + 1;
  const back = restored.count === baseline.count;
  const flagged = /reported_without_document/.test(corrupted.reasons);
  console.log(`  counter increased by 1?    ${rose}`);
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
