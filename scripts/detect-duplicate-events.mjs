#!/usr/bin/env node
/**
 * Scan all shards for duplicate events. Two flavors of dup:
 *   (a) two events with the same fiscal period label on the same ticker
 *   (b) two events with report dates < 45 days apart AND period labels
 *       consistent with a single reporting cycle (same year, adjacent
 *       or identical quarter)
 *
 * Read-only. Prints one line per affected ticker: count of events,
 * duplicate count, provenance sources involved. No writes.
 *
 *   node scripts/detect-duplicate-events.mjs
 *   node scripts/detect-duplicate-events.mjs --verbose  # per-event lines
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const args = new Set(process.argv.slice(2));
const VERBOSE = args.has("--verbose");
const CLOSE_WINDOW_DAYS = 45;

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

async function main() {
  const files = await fs.readdir(EVENTS_DIR);
  const shardFiles = files.filter((f) => f.endsWith(".json"));

  let totalEvents = 0;
  let totalTickers = 0;
  const affected = []; // { ticker, events, dupes, sources, cases }

  for (const f of shardFiles) {
    const raw = await fs.readFile(path.join(EVENTS_DIR, f), "utf-8");
    const j = JSON.parse(raw);
    const evs = Array.isArray(j) ? j : j.events ?? [];
    if (evs.length === 0) continue;
    totalTickers++;
    totalEvents += evs.length;
    const ticker = evs[0].ticker;

    // Group past events by fiscal period; also detect close-date dupes.
    const past = evs.filter((e) => e.eventDate);
    const byPeriod = new Map();
    for (const ev of past) {
      const key = ev.period ?? "unknown";
      if (!byPeriod.has(key)) byPeriod.set(key, []);
      byPeriod.get(key).push(ev);
    }

    const cases = []; // { kind: "same-period"|"close-date", period, ids, dates, provs }
    const provs = new Set();

    // Same-period dupes
    for (const [period, group] of byPeriod) {
      if (group.length > 1) {
        cases.push({
          kind: "same-period",
          period,
          ids: group.map((e) => e.id),
          dates: group.map((e) => e.eventDate),
          provs: group.map((e) => e.provenance ?? "unknown"),
        });
        for (const p of group) provs.add(p.provenance ?? "unknown");
      }
    }

    // Close-date dupes (only flag when NOT already caught by same-period).
    // Sort by date and pairwise scan; skip pairs where periods differ AND
    // the years disagree (those are truly separate reports).
    const sorted = past.slice().sort((a, b) => a.eventDate.localeCompare(b.eventDate));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      if (a.period === b.period) continue; // already caught above
      if (daysBetween(a.eventDate, b.eventDate) > CLOSE_WINDOW_DAYS) continue;
      // Extract year from period (e.g. "FY2026 Q3")
      const yearA = (a.period ?? "").match(/FY(\d{4})/)?.[1];
      const yearB = (b.period ?? "").match(/FY(\d{4})/)?.[1];
      if (yearA && yearB && yearA !== yearB) continue;
      cases.push({
        kind: "close-date",
        period: `${a.period} / ${b.period}`,
        ids: [a.id, b.id],
        dates: [a.eventDate, b.eventDate],
        provs: [a.provenance ?? "unknown", b.provenance ?? "unknown"],
      });
      provs.add(a.provenance ?? "unknown");
      provs.add(b.provenance ?? "unknown");
    }

    if (cases.length > 0) {
      const dupeCount = cases.reduce((n, c) => n + (c.ids.length - 1), 0);
      affected.push({
        ticker,
        events: past.length,
        dupes: dupeCount,
        sources: [...provs].sort(),
        cases,
      });
    }
  }

  affected.sort((a, b) => b.dupes - a.dupes);

  console.log(`Scanned ${totalTickers} shards · ${totalEvents} events total.`);
  console.log(`Affected tickers: ${affected.length}`);
  const totalDupes = affected.reduce((n, a) => n + a.dupes, 0);
  console.log(`Total duplicate events to remove: ${totalDupes}`);
  console.log();

  const provRollup = new Map();
  for (const a of affected) {
    for (const p of a.sources) provRollup.set(p, (provRollup.get(p) ?? 0) + 1);
  }
  console.log("Provenance involved (ticker count):");
  for (const [p, n] of [...provRollup].sort((x, y) => y[1] - x[1])) {
    console.log("  " + p.padEnd(28) + " " + n);
  }
  console.log();

  console.log("ticker         events dupes  sources");
  console.log("-".repeat(80));
  for (const a of affected) {
    console.log(
      a.ticker.padEnd(14) +
        " " +
        String(a.events).padStart(6) +
        " " +
        String(a.dupes).padStart(5) +
        "  " +
        a.sources.join(","),
    );
    if (VERBOSE) {
      for (const c of a.cases) {
        console.log(
          "    [" +
            c.kind +
            "] " +
            c.period +
            "  dates=" +
            c.dates.join("/") +
            "  ids=" +
            c.ids.join("/") +
            "  provs=" +
            c.provs.join("/"),
        );
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
