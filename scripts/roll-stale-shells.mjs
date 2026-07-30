#!/usr/bin/env node
/**
 * For every ticker whose "next event" shell has a scheduledDate that
 * is already in the past (Yahoo's earnings calendar predicted a date
 * that came and went without a filing landing), roll the shell
 * forward using the ticker's own median cadence and stamp the shell
 * as estimated so the UI renders "~Mmm YYYY (est.)" instead of the
 * literal "1d ago".
 *
 *   node scripts/roll-stale-shells.mjs [--dry]
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
const TODAY = new Date();
const TODAY_ISO = TODAY.toISOString().slice(0, 10);

function medianGapDays(dates) {
  if (dates.length < 2) return null;
  const sorted = dates.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i] - sorted[i - 1]) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

function periodFromDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `FY${y} Q${q}`;
}

async function main() {
  console.log(`roll-stale-shells · dry=${DRY} · today=${TODAY_ISO}`);
  const rollup = {
    schema: "roll-stale-shells/v1",
    generatedAt: new Date().toISOString(),
    totals: { shardsRead: 0, shardsWritten: 0, rolled: 0, skipped: 0 },
    rolled: [],
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

    const past = events.filter((e) => e.eventDate);
    const upcoming = events.filter((e) => !e.eventDate);
    if (upcoming.length === 0) continue;

    const pastDates = past.map((e) => e.eventDate).filter(Boolean).sort();
    const latestPastIso = pastDates[pastDates.length - 1];
    const cadence = medianGapDays(pastDates);

    for (const u of upcoming) {
      if (!u.scheduledDate) continue;
      const sched = new Date(u.scheduledDate);
      if (sched > TODAY) continue; // still future — leave alone
      // Only roll if we have a hasActual-less shell (no actual data yet).
      const hasAnyActual = (u.metrics ?? []).some((m) => m.actual?.value != null);
      if (hasAnyActual) { rollup.totals.skipped++; continue; }
      // Project a new scheduledDate.
      let nextIso;
      if (cadence && latestPastIso) {
        const nextTs = new Date(latestPastIso).getTime() + cadence * 86_400_000;
        // Guardrail: ensure the projection is in the future.
        const anchor = Math.max(nextTs, TODAY.getTime() + 3 * 86_400_000);
        nextIso = new Date(anchor).toISOString().slice(0, 10);
      } else {
        // No cadence — bump 60 days out.
        nextIso = new Date(TODAY.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
      }
      const oldIso = u.scheduledDate;
      u.scheduledDate = nextIso;
      // Keep the period label — the ticker still needs to report the
      // originally-scheduled quarter; we're only pushing OUR estimate
      // of the release date, not renaming the quarter. If the shell
      // had no period assigned yet, derive from the projected date
      // as a best-guess (rare — only newly-created empty shells).
      if (!u.period) u.period = periodFromDate(nextIso);
      u.scheduledDateSource = "roll-stale-shells/median-gap";
      u.provenance = "estimator-median-gap";
      u.provenanceAsOf = new Date().toISOString();
      rollup.totals.rolled++;
      rollup.rolled.push({ ticker: u.ticker, from: oldIso, to: nextIso, period: u.period, cadenceDays: cadence });
    }

    const nextJson = JSON.stringify(events);
    if (nextJson !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== roll-stale-shells ===`);
  console.log(`Shards read:    ${rollup.totals.shardsRead}`);
  console.log(`Shards written: ${rollup.totals.shardsWritten}`);
  console.log(`Rolled:         ${rollup.totals.rolled}`);
  console.log(`Skipped:        ${rollup.totals.skipped}`);
  for (const r of rollup.rolled) {
    console.log(`  ${r.ticker.padEnd(14)} ${r.from} → ${r.to} · ${r.period} · cadence=${r.cadenceDays?.toFixed(0) ?? "?"}d`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "roll-stale-shells.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/roll-stale-shells.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
