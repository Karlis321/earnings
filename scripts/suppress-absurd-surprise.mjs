#!/usr/bin/env node
/**
 * Defensive gate: clear surprisePct on any metric where the stored
 * value is beyond a plausibility floor. Even the biggest real-world
 * earnings beats rarely exceed +200%; anything >500% is almost
 * certainly corrupt data — mixed currencies, stale actuals paired
 * with mismatched estimates, or near-zero estimates that make the
 * ratio explode.
 *
 * Reproducer: TNZ CN FY2025 Q4 had actual=3.32 (labeled USD on a
 * CAD entity) and estimate=-0.02 (labeled USD). The math is right
 * (3.34 / 0.02 = 16700%) but the data is nonsense.
 *
 *   node scripts/suppress-absurd-surprise.mjs [--dry]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const ABSURD_THRESHOLD = 500; // % — anything beyond is suppressed

async function main() {
  console.log(`suppress-absurd-surprise · dry=${DRY} · threshold=|${ABSURD_THRESHOLD}%|`);
  const rollup = {
    schema: "suppress-absurd-surprise/v1",
    generatedAt: new Date().toISOString(),
    totals: { shardsRead: 0, shardsWritten: 0, cleared: 0 },
    cleared: [],
  };

  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(p, "utf-8")); } catch { continue; }
    rollup.totals.shardsRead++;
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const originalJson = JSON.stringify(events);

    for (const e of events) {
      for (const m of e.metrics ?? []) {
        if (m.surprisePct == null) continue;
        if (Math.abs(m.surprisePct) <= ABSURD_THRESHOLD) continue;
        // Suppress. Park on _absurdSurprise for traceability.
        if (!Array.isArray(m._absurdSurprise)) m._absurdSurprise = [];
        m._absurdSurprise.push({
          value: m.surprisePct,
          actual: m.actual?.value,
          estimate: m.estimate?.value,
          actualUnit: m.actual?.unit,
          estimateUnit: m.estimate?.unit,
          clearedAt: new Date().toISOString(),
          reason: "absurd_magnitude",
        });
        rollup.cleared.push({
          ticker: e.ticker, period: e.period, key: m.key,
          storedSurprise: m.surprisePct,
          actual: m.actual?.value, estimate: m.estimate?.value,
        });
        m.surprisePct = null;
        rollup.totals.cleared++;
      }
    }

    const next = JSON.stringify(events);
    if (next !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== suppress-absurd-surprise ===`);
  console.log(`Shards read:     ${rollup.totals.shardsRead}`);
  console.log(`Shards written:  ${rollup.totals.shardsWritten}`);
  console.log(`Surprises cleared: ${rollup.totals.cleared}`);
  console.log("\nCleared samples (first 20):");
  for (const c of rollup.cleared.slice(0, 20)) {
    console.log(`  ${c.ticker.padEnd(12)} ${c.period.padEnd(12)} ${c.key.padEnd(24)} was ${c.storedSurprise.toFixed(1)}% (actual=${c.actual} est=${c.estimate})`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "suppress-absurd-surprise.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/suppress-absurd-surprise.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
