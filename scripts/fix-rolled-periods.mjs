#!/usr/bin/env node
/**
 * The previous roll-stale-shells run rewrote period labels to
 * derive-from-scheduledDate. That was wrong: rolling only the date
 * doesn't change WHICH quarter the ticker still owes us. Fix: for
 * every shell whose scheduledDateSource = "roll-stale-shells/*",
 * reset the period to (latest-past-period + 1 quarter).
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");

function nextQuarterLabel(period) {
  const m = /^FY(\d{4})\s*Q([1-4])$/.exec(period ?? "");
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  if (q === 4) return `FY${y + 1} Q1`;
  return `FY${y} Q${q + 1}`;
}

async function main() {
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  let fixed = 0;
  const rows = [];
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(p, "utf-8")); } catch { continue; }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const original = JSON.stringify(events);

    for (const u of events) {
      if (u.eventDate) continue;
      if (u.scheduledDateSource !== "roll-stale-shells/median-gap") continue;
      // Latest past period
      const past = events.filter((e) => e.eventDate).sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
      const latestPast = past[0];
      const target = latestPast ? nextQuarterLabel(latestPast.period) : null;
      if (target && target !== u.period) {
        rows.push({ ticker: u.ticker, from: u.period, to: target });
        u.period = target;
        fixed++;
      }
    }

    const next = JSON.stringify(events);
    if (next !== original) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
    }
  }
  console.log(`Fixed ${fixed} shell periods:`);
  for (const r of rows) console.log(`  ${r.ticker.padEnd(14)} ${r.from} → ${r.to}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
