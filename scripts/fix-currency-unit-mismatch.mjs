#!/usr/bin/env node
/**
 * Yahoo occasionally returns EPS values labeled "USD" on entities
 * whose reporting currency is clearly something else (KRW, JPY, etc).
 * Example: 000660 KS FY2025 Q4 stored eps.actual = {value: 21522,
 * unit: "USD"} — value magnitude is obviously KRW (SK Hynix reports
 * in KRW; 21,522 KRW ≈ $16). Because unit != entity.currency, the
 * table row's fmtMoney call renders "21.5K" without the KRW prefix
 * (fmtMoney thinks it's USD and drops the currency label under
 * its "$ prefix" rule).
 *
 * Rule: if entity.currency !== "USD" AND metric.actual.unit === "USD"
 * AND the metric is currency-bearing (per-share EPS / *_usd_m
 * revenues), override the unit to entity.currency. Same for estimate.
 * Move the old unit to _originalUnit for traceability.
 *
 *   node scripts/fix-currency-unit-mismatch.mjs [--dry]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");

function isCurrencyBearing(key) {
  if (!key) return false;
  if (/^eps/.test(key)) return true;
  if (/_usd_m$/.test(key)) return true; // legacy naming
  if (/_[a-z]{3}_m$/.test(key)) return true;
  return false;
}

async function main() {
  console.log(`fix-currency-unit-mismatch · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  const rollup = {
    schema: "fix-currency-unit-mismatch/v1",
    generatedAt: new Date().toISOString(),
    totals: { shardsRead: 0, shardsWritten: 0, actualsFixed: 0, estimatesFixed: 0 },
    fixesByEntityCurrency: {},
    samples: [],
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
      const entity = byTicker.get(e.ticker);
      const currency = entity?.currency;
      if (!currency || currency === "USD") continue;

      for (const m of e.metrics ?? []) {
        if (!isCurrencyBearing(m.key)) continue;

        // Fix actual
        if (m.actual && m.actual.unit === "USD" && m.actual.value != null) {
          if (!m.actual._originalUnit) m.actual._originalUnit = "USD";
          m.actual.unit = currency;
          rollup.totals.actualsFixed++;
          rollup.fixesByEntityCurrency[currency] = (rollup.fixesByEntityCurrency[currency] ?? 0) + 1;
          if (rollup.samples.length < 30) {
            rollup.samples.push({
              ticker: e.ticker, period: e.period, key: m.key,
              value: m.actual.value, oldUnit: "USD", newUnit: currency,
              side: "actual",
            });
          }
        }

        // Fix estimate similarly
        if (m.estimate && m.estimate.unit === "USD" && m.estimate.value != null) {
          if (!m.estimate._originalUnit) m.estimate._originalUnit = "USD";
          m.estimate.unit = currency;
          rollup.totals.estimatesFixed++;
        }
      }
    }

    const next = JSON.stringify(events);
    if (next !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== fix-currency-unit-mismatch ===`);
  console.log(`Shards read:       ${rollup.totals.shardsRead}`);
  console.log(`Shards written:    ${rollup.totals.shardsWritten}`);
  console.log(`Actuals fixed:     ${rollup.totals.actualsFixed}`);
  console.log(`Estimates fixed:   ${rollup.totals.estimatesFixed}`);
  console.log("\nActuals fixed by currency:");
  for (const [c, n] of Object.entries(rollup.fixesByEntityCurrency).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n}`);
  }
  console.log("\nSample fixes (first 15):");
  for (const s of rollup.samples.slice(0, 15)) {
    console.log(`  ${s.ticker.padEnd(14)} ${s.period.padEnd(12)} ${s.key.padEnd(20)} ${s.side} ${s.value} ${s.oldUnit}→${s.newUnit}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "fix-currency-unit-mismatch.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/fix-currency-unit-mismatch.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
