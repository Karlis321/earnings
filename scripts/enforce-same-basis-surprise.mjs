#!/usr/bin/env node
/**
 * Enforce same-basis surprise triples (Stage 1B/c fix). For every
 * past-event metric where surprisePct is set BUT actual + estimate
 * come from different provenance families, clear surprisePct — the
 * comparison is fundamentally apples-to-oranges (typical case: SEC
 * XBRL GAAP EPS Basic vs Yahoo consensus adjusted EPS).
 *
 * Move the cleared value to metric._crossBasisSurprise for
 * traceability. Also normalize the invariant across the universe.
 *
 *   node scripts/enforce-same-basis-surprise.mjs [--dry]
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

// Provenance FAMILY: within a family, the actual + estimate come
// from paired samples of the same population (e.g. Yahoo's
// earningsChart returns matched quarterly actual/estimate pairs;
// SEC XBRL uses one accounting basis). Across families, the pair
// mixes definitions — GAAP actual vs adjusted-EPS estimate.
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

// Are two facts same-basis for the purpose of surprise%?
// Rule: yahoo-chart pairs with yahoo-chart or yahoo-trend (same
// analyst-consensus population). SEC-XBRL only pairs with SEC-XBRL.
// yahoo-timeseries is GAAP-derived from filings; only pairs with
// yahoo-timeseries or SEC (both GAAP). Otherwise cross-basis.
function isSameBasis(actualFact, estimateFact) {
  const a = provenanceFamily(actualFact);
  const e = provenanceFamily(estimateFact);
  if (a === "unknown" || e === "unknown") return false;
  if (a === e) return true;
  // yahoo-chart <-> yahoo-trend: both analyst consensus, same basis.
  const yahooConsensus = new Set(["yahoo-chart", "yahoo-trend"]);
  if (yahooConsensus.has(a) && yahooConsensus.has(e)) return true;
  // sec <-> yahoo-timeseries: both GAAP-from-filing. Safe pairing.
  const gaapFiling = new Set(["sec", "yahoo-timeseries"]);
  if (gaapFiling.has(a) && gaapFiling.has(e)) return true;
  // sec + fmp: FMP mirrors GAAP filings. Safe.
  if ((a === "sec" && e === "fmp") || (a === "fmp" && e === "sec")) return true;
  // Anything else: cross-basis.
  return false;
}

async function main() {
  console.log(`enforce-same-basis-surprise · dry=${DRY}`);
  const rollup = {
    schema: "enforce-same-basis-surprise/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      shardsRead: 0,
      shardsWritten: 0,
      triplesScanned: 0,
      keptSameBasis: 0,
      clearedCrossBasis: 0,
    },
    crossBasisByPair: {},
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
      if (!e.eventDate) continue;
      for (const m of e.metrics ?? []) {
        if (m.surprisePct == null) continue;
        if (m.actual?.value == null || m.estimate?.value == null) continue;
        rollup.totals.triplesScanned++;
        if (isSameBasis(m.actual, m.estimate)) {
          rollup.totals.keptSameBasis++;
          continue;
        }
        // Cross-basis: clear surprisePct, park it on _crossBasisSurprise.
        const aFam = provenanceFamily(m.actual);
        const eFam = provenanceFamily(m.estimate);
        const pair = `${aFam}+${eFam}`;
        rollup.crossBasisByPair[pair] = (rollup.crossBasisByPair[pair] ?? 0) + 1;
        rollup.totals.clearedCrossBasis++;
        if (rollup.samples.length < 30) {
          rollup.samples.push({
            ticker: e.ticker,
            period: e.period,
            key: m.key,
            actual: m.actual.value,
            estimate: m.estimate.value,
            oldSurprisePct: m.surprisePct,
            actualFamily: aFam,
            estimateFamily: eFam,
          });
        }
        // Park the old value.
        if (!m._crossBasisSurprise) m._crossBasisSurprise = [];
        m._crossBasisSurprise.push({
          value: m.surprisePct,
          actualFamily: aFam,
          estimateFamily: eFam,
          clearedAt: new Date().toISOString(),
        });
        m.surprisePct = null;
      }
    }

    const next = JSON.stringify(events);
    if (next !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== enforce-same-basis-surprise ===`);
  console.log(`Shards read:                 ${rollup.totals.shardsRead}`);
  console.log(`Shards written:              ${rollup.totals.shardsWritten}`);
  console.log(`Triples scanned:             ${rollup.totals.triplesScanned}`);
  console.log(`Kept (same-basis):           ${rollup.totals.keptSameBasis}`);
  console.log(`Cleared (cross-basis):       ${rollup.totals.clearedCrossBasis}`);
  console.log("\nCross-basis by (actual+estimate) family:");
  for (const [k, v] of Object.entries(rollup.crossBasisByPair).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "enforce-same-basis-surprise.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/enforce-same-basis-surprise.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
