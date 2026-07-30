#!/usr/bin/env node
/**
 * Sweep for metric-level duplicates and label clashes (Stage 1B/d).
 * Two failure modes:
 *   1. Same metric.key appears twice on one event's metrics array.
 *      countDuplicates in pipelineReport checks event-level dedup, not
 *      metric-level — this catches the gap.
 *   2. Two keys map to visually identical display labels (e.g.
 *      "EPS" for both eps_usd and eps_diluted_usd, which read as a
 *      duplicate row on the card). Normalize so basic vs diluted
 *      always render as distinct labels.
 *
 * Merge rule when key-dupes exist: keep the highest-confidence actual
 * (prefer sec-* over yahoo-*); merge estimates similarly; move losers
 * to superseded[].
 *
 *   node scripts/sweep-metric-duplicates.mjs [--dry]
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

// Normalize display labels so basic vs diluted read as distinct.
const LABEL_OVERRIDES = {
  eps_usd: "EPS (basic)",
  eps_diluted_usd: "EPS (diluted)",
};

function provRank(fact) {
  const l = fact?.source?.label ?? "";
  if (/SEC EDGAR|companyfacts|EarningsPerShare|10-Q|10-K|20-F/i.test(l)) return 100;
  if (/submissions/i.test(l)) return 90;
  if (fact?.method === "filing_manual") return 95;
  if (/fundamentals-timeseries/i.test(l)) return 80;
  if (/earningsChart/i.test(l)) return 40;
  if (/earningsTrend/i.test(l)) return 40;
  if (/Yahoo Finance/i.test(l)) return 30;
  if (/FMP/i.test(l)) return 30;
  return 10;
}

async function main() {
  console.log(`sweep-metric-duplicates · dry=${DRY}`);
  const rollup = {
    schema: "sweep-metric-duplicates/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      shardsRead: 0,
      shardsWritten: 0,
      keyDupesMerged: 0,
      labelOverridesApplied: 0,
    },
    keyDupes: [],
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
      if (!Array.isArray(e.metrics)) continue;

      // Label overrides (applies to every metric, no dedup needed).
      for (const m of e.metrics) {
        if (LABEL_OVERRIDES[m.key] && m.displayLabel !== LABEL_OVERRIDES[m.key]) {
          m.displayLabel = LABEL_OVERRIDES[m.key];
          rollup.totals.labelOverridesApplied++;
        }
      }

      // Key-level dedup.
      const grouped = new Map();
      for (const m of e.metrics) {
        if (!grouped.has(m.key)) grouped.set(m.key, []);
        grouped.get(m.key).push(m);
      }
      let mutated = false;
      const merged = [];
      for (const [key, arr] of grouped) {
        if (arr.length === 1) { merged.push(arr[0]); continue; }
        // Duplicate key. Keep highest-confidence actual + highest-confidence estimate.
        rollup.totals.keyDupesMerged += arr.length - 1;
        rollup.keyDupes.push({
          ticker: e.ticker, period: e.period, key,
          copies: arr.map((x) => ({ actual: x.actual?.value, estimate: x.estimate?.value, source: x.actual?.source?.label })),
        });
        arr.sort((a, b) => provRank(b.actual) - provRank(a.actual));
        const winner = arr[0];
        // Preserve losers as superseded entries on the winner.
        if (!Array.isArray(winner.superseded)) winner.superseded = [];
        for (const loser of arr.slice(1)) {
          if (loser.actual?.value != null) {
            winner.superseded.push({
              value: loser.actual.value,
              unit: loser.actual.unit,
              source: loser.actual.source?.label ?? null,
              replaced_at: new Date().toISOString(),
              replaced_by: "sweep-metric-duplicates",
              reason: "duplicate-key",
            });
          }
        }
        // If winner lacks an estimate but a loser has one, promote it.
        if (winner.estimate?.value == null) {
          const withEst = arr.find((x, i) => i > 0 && x.estimate?.value != null);
          if (withEst) winner.estimate = withEst.estimate;
        }
        merged.push(winner);
        mutated = true;
      }
      if (mutated) e.metrics = merged;
    }

    const next = JSON.stringify(events);
    if (next !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== sweep-metric-duplicates ===`);
  console.log(`Shards read:              ${rollup.totals.shardsRead}`);
  console.log(`Shards written:           ${rollup.totals.shardsWritten}`);
  console.log(`Key-duplicates merged:    ${rollup.totals.keyDupesMerged}`);
  console.log(`Label overrides applied:  ${rollup.totals.labelOverridesApplied}`);
  console.log(`\nKey-dupe samples (first 10):`);
  for (const d of rollup.keyDupes.slice(0, 10)) {
    console.log(`  ${d.ticker} ${d.period} ${d.key}: ${d.copies.length} copies`);
    for (const c of d.copies) console.log(`     actual=${c.actual} est=${c.estimate} src=${(c.source ?? "?").slice(0, 40)}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "sweep-metric-duplicates.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/sweep-metric-duplicates.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
