#!/usr/bin/env node
/**
 * Per-ticker: verify the events-index's lastEventId + nextEventId
 * resolve to a real event on the shard AND the period matches what
 * the index claims. Report:
 *   OK               id resolves, period matches
 *   DEAD             id absent from shard
 *   PERIOD_MISMATCH  id resolves but period differs
 *
 * These pointers are what /s/[ticker]/e/[eventId] navigates to on
 * "Open ↗" clicks from past-quarters + watchlist "next" links —
 * dead ids yield a 404 or a wrong quarter.
 *
 *   node scripts/audit-event-ids.mjs
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const IDX_PATH = path.join(ROOT, "data", "events-index.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  const idx = JSON.parse(await fs.readFile(IDX_PATH, "utf-8"));
  const entries = idx.entries ?? [];

  const rollup = {
    schema: "audit-event-ids/v1",
    generatedAt: new Date().toISOString(),
    counts: {
      total: entries.length,
      lastEvent_ok: 0,
      lastEvent_dead: 0,
      lastEvent_periodMismatch: 0,
      lastEvent_none: 0,
      nextEvent_ok: 0,
      nextEvent_dead: 0,
      nextEvent_periodMismatch: 0,
      nextEvent_none: 0,
      shardMissing: 0,
    },
    deadLastEvent: [],
    periodMismatch: [],
    deadNextEvent: [],
  };

  for (const e of entries) {
    const shardPath = path.join(EVENTS_DIR, tickerSlug(e.ticker) + ".json");
    let evs = [];
    try {
      const j = JSON.parse(fssync.readFileSync(shardPath, "utf-8"));
      evs = Array.isArray(j) ? j : j.events ?? [];
    } catch {
      rollup.counts.shardMissing++;
      continue;
    }

    // lastEventId
    if (!e.lastEventId) {
      rollup.counts.lastEvent_none++;
    } else {
      const target = evs.find((x) => x.id === e.lastEventId);
      if (!target) {
        rollup.counts.lastEvent_dead++;
        rollup.deadLastEvent.push({
          ticker: e.ticker, idxId: e.lastEventId, idxPeriod: e.lastPeriod,
          idxEventDate: e.lastEventDate,
          shardIds: evs.filter((x) => x.eventDate).map((x) => ({ id: x.id, period: x.period, eventDate: x.eventDate })).slice(-3),
        });
      } else if (target.period !== e.lastPeriod) {
        rollup.counts.lastEvent_periodMismatch++;
        rollup.periodMismatch.push({
          ticker: e.ticker, id: e.lastEventId, idxPeriod: e.lastPeriod, shardPeriod: target.period,
        });
      } else {
        rollup.counts.lastEvent_ok++;
      }
    }

    // nextEventId
    if (!e.nextEventId) {
      rollup.counts.nextEvent_none++;
    } else {
      const target = evs.find((x) => x.id === e.nextEventId);
      if (!target) {
        rollup.counts.nextEvent_dead++;
        rollup.deadNextEvent.push({
          ticker: e.ticker, idxId: e.nextEventId, idxPeriod: e.nextPeriod,
        });
      } else if (target.period !== e.nextPeriod) {
        rollup.counts.nextEvent_periodMismatch++;
      } else {
        rollup.counts.nextEvent_ok++;
      }
    }
  }

  console.log("=== audit-event-ids ===");
  console.log(`Total registry entries:          ${rollup.counts.total}`);
  console.log(`Shards missing:                  ${rollup.counts.shardMissing}`);
  console.log("--- lastEventId ---");
  console.log(`  OK:                            ${rollup.counts.lastEvent_ok}`);
  console.log(`  DEAD (id not in shard):        ${rollup.counts.lastEvent_dead}`);
  console.log(`  PERIOD MISMATCH:               ${rollup.counts.lastEvent_periodMismatch}`);
  console.log(`  none (upcoming-only ticker):   ${rollup.counts.lastEvent_none}`);
  console.log("--- nextEventId ---");
  console.log(`  OK:                            ${rollup.counts.nextEvent_ok}`);
  console.log(`  DEAD:                          ${rollup.counts.nextEvent_dead}`);
  console.log(`  PERIOD MISMATCH:               ${rollup.counts.nextEvent_periodMismatch}`);
  console.log(`  none:                          ${rollup.counts.nextEvent_none}`);
  if (rollup.deadLastEvent.length > 0) {
    console.log("\nFirst 15 dead lastEventIds:");
    for (const d of rollup.deadLastEvent.slice(0, 15)) {
      console.log(`  ${d.ticker.padEnd(14)} idx: ${d.idxId} ${d.idxPeriod} @${d.idxEventDate} · shard last 3: ${d.shardIds.map((x) => `${x.id}(${x.period})`).join(", ")}`);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "audit-event-ids.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/audit-event-ids.json`);

  // Standing-test exit code: fail on any dead pointer.
  const dead =
    rollup.counts.lastEvent_dead +
    rollup.counts.lastEvent_periodMismatch +
    rollup.counts.nextEvent_dead +
    rollup.counts.nextEvent_periodMismatch;
  if (dead > 0) {
    console.error(`✗ ${dead} dead / mismatched event id(s) — index and shards drifted`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
