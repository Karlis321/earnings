#!/usr/bin/env node
/**
 * Recompute surprisePct on every metric where actual + estimate are
 * both populated. The July SEC-verbatim rederive replaced Yahoo
 * actuals with authoritative SEC values on many events (e.g. CENX
 * FY2026 Q1: Yahoo 1.63 → SEC 3.41) but did NOT recompute the
 * metric's surprisePct — so the pill on the ticker card / event
 * card shows math that no longer reconciles ("actual 3.41 vs
 * estimate 1.77 · Beat -8.2%" reads like an obvious bug).
 *
 * Rule: surprisePct = ((actual - estimate) / |estimate|) × 100
 * Skip when estimate is 0 (undefined percentage) or either side null.
 *
 *   node scripts/recompute-surprise.mjs [--dry]
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

// Provenance-family check — mirrors enforce-same-basis-surprise.mjs.
// A wrong surprise is worse than none: never recompute across bases.
function provenanceFamily(fact) {
  const l = fact?.source?.label ?? "";
  if (/SEC EDGAR|companyfacts|EarningsPerShare|10-Q|10-K|20-F/i.test(l)) return "sec";
  if (/submissions/i.test(l)) return "sec";
  if (/earningsChart/i.test(l)) return "yahoo-chart";
  if (/earningsTrend/i.test(l)) return "yahoo-trend";
  if (/fundamentals-timeseries/i.test(l)) return "yahoo-timeseries";
  if (/Yahoo Finance/i.test(l)) return "yahoo-generic";
  if (/FMP/i.test(l)) return "fmp";
  return "unknown";
}
function isSameBasis(actualFact, estimateFact) {
  const a = provenanceFamily(actualFact);
  const e = provenanceFamily(estimateFact);
  if (a === "unknown" || e === "unknown") return false;
  if (a === e) return true;
  const yahooConsensus = new Set(["yahoo-chart", "yahoo-trend"]);
  if (yahooConsensus.has(a) && yahooConsensus.has(e)) return true;
  const gaapFiling = new Set(["sec", "yahoo-timeseries"]);
  if (gaapFiling.has(a) && gaapFiling.has(e)) return true;
  if ((a === "sec" && e === "fmp") || (a === "fmp" && e === "sec")) return true;
  return false;
}

async function main() {
  console.log(`recompute-surprise · dry=${DRY}`);
  const rollup = {
    schema: "recompute-surprise/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      shardsRead: 0,
      shardsWritten: 0,
      recomputed: 0,
      unchanged: 0,
      clearedBecauseMissingSide: 0,
    },
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
      for (const m of (e.metrics ?? [])) {
        const actual = m.actual?.value;
        const estimate = m.estimate?.value;
        const prev = m.surprisePct;
        // If either side is missing, surprisePct must be null.
        if (actual == null || estimate == null || Math.abs(estimate) < 1e-9) {
          if (prev != null) {
            m.surprisePct = null;
            rollup.totals.clearedBecauseMissingSide++;
          }
          continue;
        }
        // Gate: refuse to compute surprise when actual + estimate come
        // from different accounting bases (Stage 1B fix). Cross-basis
        // surprise% misleads more than it informs. If bases differ,
        // clear the stored value.
        if (!isSameBasis(m.actual, m.estimate)) {
          if (prev != null) {
            m.surprisePct = null;
            rollup.totals.clearedBecauseMissingSide++;
          }
          continue;
        }
        const next = ((actual - estimate) / Math.abs(estimate)) * 100;
        // Tolerance: only mark as changed if the delta > 0.01 percentage
        // point AND the sign or magnitude meaningfully differs from prev.
        if (prev == null || Math.abs(prev - next) > 0.01) {
          m.surprisePct = next;
          rollup.totals.recomputed++;
          if (rollup.samples.length < 30) {
            rollup.samples.push({
              ticker: e.ticker,
              period: e.period,
              metric: m.key,
              actual,
              estimate,
              prevSurprise: prev,
              newSurprise: next,
            });
          }
        } else {
          rollup.totals.unchanged++;
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

  console.log(`\n=== recompute-surprise ===`);
  console.log(`Shards read:               ${rollup.totals.shardsRead}`);
  console.log(`Shards written:            ${rollup.totals.shardsWritten}`);
  console.log(`Surprise recomputed:       ${rollup.totals.recomputed}`);
  console.log(`Surprise unchanged:        ${rollup.totals.unchanged}`);
  console.log(`Cleared (missing side):    ${rollup.totals.clearedBecauseMissingSide}`);
  console.log(`\nSamples (first 15):`);
  for (const s of rollup.samples.slice(0, 15)) {
    console.log(`  ${s.ticker.padEnd(12)} ${s.period.padEnd(12)} ${s.metric.padEnd(24)} actual=${s.actual} est=${s.estimate} · was ${s.prevSurprise?.toFixed(2) ?? "null"}% → ${s.newSurprise.toFixed(2)}%`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "recompute-surprise.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/recompute-surprise.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
