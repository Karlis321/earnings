#!/usr/bin/env node
/**
 * Sweep 1: fix impossible next-period labels on all estimator shells.
 *
 * Bug: `estimateNextEvent.ts` and its `.mjs` mirror both derived the
 * shell label from the calendar quarter of the projected DATE, not by
 * incrementing from the latest known period. That's wrong for every
 * non-calendar-year filer — MSFT (fiscal year ends June), AAPL (Sep),
 * NVDA (Jan), WMT (Jan), most Japanese and Australian names.
 *
 * This one-off script scans every forward-dated (estimator or Yahoo)
 * shell, detects impossible labels, and rewrites them by incrementing
 * the latest reported period along the ticker's cadence. Runs against
 * the shard set (no monolith dependency).
 *
 *   node scripts/fix-estimator-labels.mjs             # write
 *   node scripts/fix-estimator-labels.mjs --dry       # report only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");

function parsePeriod(label) {
  const m = /FY\s*(\d{4})\s+Q\s*(\d)/i.exec(label ?? "");
  if (!m) return null;
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

function periodBefore(a, b) {
  // Return true if period a is STRICTLY BEFORE period b (comparable across years).
  const pa = parsePeriod(a);
  const pb = parsePeriod(b);
  if (!pa || !pb) return false;
  return pa.year * 4 + pa.quarter < pb.year * 4 + pb.quarter;
}

function periodEquals(a, b) {
  const pa = parsePeriod(a);
  const pb = parsePeriod(b);
  return pa && pb && pa.year === pb.year && pa.quarter === pb.quarter;
}

function incrementPeriod(label, cadence) {
  const p = parsePeriod(label);
  if (!p) return null;
  let year = p.year;
  let q = p.quarter;
  const stepQ =
    cadence === "quarterly" ? 1 :
    cadence === "semiannual" ? 2 :
    cadence === "annual" ? 4 : 1;
  q += stepQ;
  while (q > 4) { q -= 4; year++; }
  return `FY${year} Q${q}`;
}

async function main() {
  console.log(`fix-estimator-labels · dry=${DRY}`);
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  let scanned = 0;
  let forward = 0;
  let violations = 0;
  let fixed = 0;
  const shardsDirty = new Set();
  const shardBodies = new Map(); // path → {wrapped, body, events}
  const violationSamples = [];

  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const wrapped = !Array.isArray(j);
    const evs = wrapped ? (j.events ?? []) : j;
    shardBodies.set(p, { wrapped, body: j, events: evs });
    scanned += evs.length;

    // Find latest reported period per ticker within this shard
    const past = evs.filter((e) => e.eventDate);
    if (past.length === 0) {
      // No past events → any forward shell here has no reference; leave alone
      continue;
    }
    past.sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
    const latestPast = past[past.length - 1];
    const latestPeriod = latestPast.period;

    const futures = evs.filter((e) => !e.eventDate);
    for (const fut of futures) {
      forward++;
      // Violation: forward event's period is BEFORE or EQUAL to the latest reported period
      // (strictly after is the invariant — Q4 report followed by Q4 report is invalid)
      const isBefore = periodBefore(fut.period, latestPeriod);
      const isEqual = periodEquals(fut.period, latestPeriod);
      if (!isBefore && !isEqual) continue;
      violations++;
      if (violationSamples.length < 20) {
        violationSamples.push({
          ticker: fut.ticker,
          latestReported: latestPeriod,
          projectedLabel: fut.period,
          projectedDate: fut.scheduledDate,
        });
      }
      // Fix: increment latestPeriod by cadence (fall back to quarterly if not set)
      const cadence = fut.cadence ?? "quarterly";
      const fixed_label = incrementPeriod(latestPeriod, cadence);
      if (fixed_label) {
        fut.period = fixed_label;
        fixed++;
        shardsDirty.add(p);
      }
    }
  }

  console.log(`\n=== Scan ===`);
  console.log(`Events scanned:   ${scanned}`);
  console.log(`Forward shells:   ${forward}`);
  console.log(`Violations:       ${violations}`);
  console.log(`Fixed:            ${fixed}`);
  console.log(`Shards to write:  ${shardsDirty.size}`);

  if (violationSamples.length > 0) {
    console.log(`\nFirst ${violationSamples.length} violations:`);
    for (const s of violationSamples) {
      console.log(
        `  ${s.ticker.padEnd(14)}  latest=${(s.latestReported ?? "-").padEnd(14)}  projected=${(s.projectedLabel ?? "-").padEnd(14)}  on ${s.projectedDate}`,
      );
    }
  }

  if (DRY) {
    console.log("\nDry run — no writes.");
    return;
  }
  for (const p of shardsDirty) {
    const ctx = shardBodies.get(p);
    const body = ctx.wrapped ? { ...ctx.body, events: ctx.events } : ctx.events;
    await fs.writeFile(p, JSON.stringify(body, null, 2));
  }
  console.log(`\n✓ updated ${shardsDirty.size} shards`);
}

main().catch((e) => { console.error(e); process.exit(1); });
