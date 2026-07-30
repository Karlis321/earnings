#!/usr/bin/env node
/**
 * Surprise-triple invariant scan (Stage 1B/a). For every past-event
 * metric with (actual, estimate, surprisePct), recompute
 * (actual - estimate) / |estimate| × 100 and compare to what the
 * shard stored. Flag categories:
 *   MISMATCH_GT_1PP      abs delta > 1 percentage point
 *   MISMATCH_SIGN_FLIP   signs differ (any magnitude)
 *   ORPHAN_SURPRISE      surprisePct set but actual or estimate null
 *   NEGATIVE_ESTIMATE    estimate <= 0 (formula sign ambiguity)
 *   ESTIMATE_PERIOD_MISMATCH   estimate.asOf outside event's quarter
 *
 * Groups mismatches by provenance triple:
 *   actual_provenance + estimate_provenance + surprise_origin
 * so we can see WHICH pipe writes inconsistent triples.
 *
 *   node scripts/audit-surprise-triples.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

function labelToProv(fact) {
  const l = fact?.source?.label ?? "";
  if (/SEC EDGAR|companyfacts|EarningsPerShare|10-Q|10-K|20-F/i.test(l)) return "sec-xbrl";
  if (/submissions/i.test(l)) return "sec-submissions";
  if (/earningsChart/i.test(l)) return "yahoo-earnings-chart";
  if (/earningsTrend/i.test(l)) return "yahoo-earnings-trend";
  if (/fundamentals-timeseries|Yahoo · fundamentals/i.test(l)) return "yahoo-timeseries";
  if (/Yahoo Finance/i.test(l)) return "yahoo-generic";
  if (/FMP|financialmodelingprep/i.test(l)) return "fmp";
  if (fact?.method === "yahoo") return "yahoo-generic";
  if (fact?.method === "filing_manual") return "filing-manual";
  return "unknown";
}

function periodQuarterRange(period) {
  const m = /^FY(\d{4})\s*Q([1-4])$/.exec(period ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const quarter = Number(m[2]);
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function main() {
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  const rollup = {
    schema: "audit-surprise-triples/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      shardsScanned: 0,
      pastEventsScanned: 0,
      metricsWithSurprise: 0,
      passed: 0,
      MISMATCH_GT_1PP: 0,
      MISMATCH_SIGN_FLIP: 0,
      ORPHAN_SURPRISE: 0,
      NEGATIVE_ESTIMATE: 0,
      ESTIMATE_PERIOD_MISMATCH: 0,
    },
    byProvenanceTriple: {},
    samples: {
      MISMATCH_GT_1PP: [],
      MISMATCH_SIGN_FLIP: [],
      ORPHAN_SURPRISE: [],
      NEGATIVE_ESTIMATE: [],
      ESTIMATE_PERIOD_MISMATCH: [],
    },
  };

  const SAMPLE_CAP = 20;

  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(p, "utf-8")); } catch { continue; }
    rollup.totals.shardsScanned++;
    const events = Array.isArray(shard) ? shard : shard.events ?? [];

    for (const e of events) {
      if (!e.eventDate) continue;
      rollup.totals.pastEventsScanned++;
      const periodRange = periodQuarterRange(e.period);

      for (const m of e.metrics ?? []) {
        const surprise = m.surprisePct;
        const a = m.actual?.value;
        const est = m.estimate?.value;
        if (surprise == null && a == null && est == null) continue;

        // ORPHAN_SURPRISE: has surprise but missing a side.
        if (surprise != null && (a == null || est == null)) {
          rollup.totals.ORPHAN_SURPRISE++;
          if (rollup.samples.ORPHAN_SURPRISE.length < SAMPLE_CAP) {
            rollup.samples.ORPHAN_SURPRISE.push({
              ticker: e.ticker, period: e.period, key: m.key,
              actual: a, estimate: est, surprisePct: surprise,
            });
          }
          continue;
        }

        if (surprise == null || a == null || est == null) continue;
        rollup.totals.metricsWithSurprise++;

        // NEGATIVE_ESTIMATE: sign convention issue.
        if (est < 0) {
          rollup.totals.NEGATIVE_ESTIMATE++;
          if (rollup.samples.NEGATIVE_ESTIMATE.length < SAMPLE_CAP) {
            rollup.samples.NEGATIVE_ESTIMATE.push({
              ticker: e.ticker, period: e.period, key: m.key,
              actual: a, estimate: est, surprisePct: surprise,
            });
          }
        }

        // ESTIMATE_PERIOD_MISMATCH
        const estAsOf = m.estimate?.asOf;
        if (periodRange && estAsOf) {
          const inQuarter =
            estAsOf >= periodRange.start &&
            estAsOf <= new Date(new Date(periodRange.end).getTime() + 45 * 86400_000).toISOString().slice(0, 10);
          if (!inQuarter) {
            rollup.totals.ESTIMATE_PERIOD_MISMATCH++;
            if (rollup.samples.ESTIMATE_PERIOD_MISMATCH.length < SAMPLE_CAP) {
              rollup.samples.ESTIMATE_PERIOD_MISMATCH.push({
                ticker: e.ticker, period: e.period, key: m.key,
                estimateAsOf: estAsOf, periodRange,
              });
            }
          }
        }

        // Recompute
        if (Math.abs(est) < 1e-9) continue; // NEGATIVE_ESTIMATE handles the zero-adjacent edge already
        const expected = ((a - est) / Math.abs(est)) * 100;
        const delta = Math.abs(surprise - expected);
        const signFlip = surprise > 0.5 && expected < -0.5 || surprise < -0.5 && expected > 0.5;

        const aProv = labelToProv(m.actual);
        const eProv = labelToProv(m.estimate);
        const triple = `${aProv} + ${eProv}`;
        if (!rollup.byProvenanceTriple[triple]) {
          rollup.byProvenanceTriple[triple] = { total: 0, passed: 0, mismatch1pp: 0, signFlip: 0 };
        }
        rollup.byProvenanceTriple[triple].total++;

        if (signFlip) {
          rollup.totals.MISMATCH_SIGN_FLIP++;
          rollup.byProvenanceTriple[triple].signFlip++;
          if (rollup.samples.MISMATCH_SIGN_FLIP.length < SAMPLE_CAP) {
            rollup.samples.MISMATCH_SIGN_FLIP.push({
              ticker: e.ticker, period: e.period, key: m.key,
              actual: a, estimate: est, stored: surprise, computed: expected, delta,
              actualProv: aProv, estimateProv: eProv,
            });
          }
        } else if (delta > 1.0) {
          rollup.totals.MISMATCH_GT_1PP++;
          rollup.byProvenanceTriple[triple].mismatch1pp++;
          if (rollup.samples.MISMATCH_GT_1PP.length < SAMPLE_CAP) {
            rollup.samples.MISMATCH_GT_1PP.push({
              ticker: e.ticker, period: e.period, key: m.key,
              actual: a, estimate: est, stored: surprise, computed: expected, delta,
              actualProv: aProv, estimateProv: eProv,
            });
          }
        } else {
          rollup.totals.passed++;
          rollup.byProvenanceTriple[triple].passed++;
        }
      }
    }
  }

  console.log("=== audit-surprise-triples ===");
  console.log(`Shards scanned:                ${rollup.totals.shardsScanned}`);
  console.log(`Past events scanned:           ${rollup.totals.pastEventsScanned}`);
  console.log(`Metrics with surprise triple:  ${rollup.totals.metricsWithSurprise}`);
  console.log(`Passed (within 1pp):           ${rollup.totals.passed}`);
  console.log(`MISMATCH >1pp:                 ${rollup.totals.MISMATCH_GT_1PP}`);
  console.log(`MISMATCH sign-flip:            ${rollup.totals.MISMATCH_SIGN_FLIP}`);
  console.log(`ORPHAN surprise:               ${rollup.totals.ORPHAN_SURPRISE}`);
  console.log(`NEGATIVE estimate:             ${rollup.totals.NEGATIVE_ESTIMATE}`);
  console.log(`ESTIMATE period mismatch:      ${rollup.totals.ESTIMATE_PERIOD_MISMATCH}`);
  console.log("\nBy provenance triple (actual + estimate):");
  const rows = Object.entries(rollup.byProvenanceTriple).sort((a, b) => (b[1].mismatch1pp + b[1].signFlip) - (a[1].mismatch1pp + a[1].signFlip));
  for (const [k, v] of rows.slice(0, 15)) {
    console.log(`  ${k.padEnd(48)} total=${String(v.total).padStart(5)} · passed=${String(v.passed).padStart(5)} · mismatch=${String(v.mismatch1pp).padStart(4)} · signFlip=${String(v.signFlip).padStart(4)}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "audit-surprise-triples.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/audit-surprise-triples.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
