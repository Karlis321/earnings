#!/usr/bin/env node
/**
 * Canonicalize duplicate events per ticker. Two dedup groupings:
 *
 *   (1) Same fiscal period label — clear dup, always merge.
 *   (2) sec-submissions events within a 45-day window — these carry no
 *       real financial data (only filing_reference markers), and cluster
 *       around a single underlying reporting cycle for foreign filers
 *       (BHP files ~4 separate 6-Ks per interim). Merge them.
 *
 * Not merged: two events with real actuals on close dates but different
 * period labels (fiscal-calendar offset — e.g. HD MM Q3 vs SEC XBRL Q4).
 * Those represent distinct data and need a fiscal-calendar-aware pass;
 * out of scope for this dedup.
 *
 * Merge rules per group:
 *   - `winner`: the event with the "richest" provenance (see PROVENANCE_RANK)
 *   - Metrics: union across the group by key. On conflict, the higher-ranked
 *     provenance wins; losing values move to `superseded: [{ ... }]` on the
 *     winner so nothing is silently discarded.
 *   - `eventDate`: earliest across the group (safer than latest — earliest
 *     is likely the actual reporting date; later 6-Ks are commentary).
 *   - `provenance_merged`: sorted unique list of all contributing provenances.
 *
 *   node scripts/dedupe-events.mjs --dry          # report only, no writes
 *   node scripts/dedupe-events.mjs                # write shards + monolith
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const EARNINGS = path.join(ROOT, "data", "earnings.json");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");

// Higher rank = wins on conflict. Real-actuals sources dominate filing shells.
const PROVENANCE_RANK = {
  "sec-xbrl-companyfacts": 100,
  "yahoo-timeseries": 90,
  "yahoo-earnings-chart": 80,
  fmp: 70,
  "manual-entry": 60,
  "sec-submissions": 20,
  "estimator-median-gap": 10,
  fixture: 5,
  unknown: 0,
};
function rank(p) {
  return PROVENANCE_RANK[p ?? "unknown"] ?? 0;
}

const CLOSE_WINDOW_DAYS = 45;

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

// Cluster past events into merge groups. Three passes:
//   (1) Same fiscal-period label — always merge
//   (2) sec-submissions within 45d — filing-marker clusters
//   (3) Cross-provenance within 45d — fiscal-calendar-offset (yahoo says
//       calendar-Q3 for Apple's 2025-03-31 report, SEC XBRL says
//       fiscal-Q2 for the same period-end). SEC XBRL wins on rank; the
//       yahoo-timeseries actuals move to `superseded` so nothing is lost.
function clusterForMerge(pastEvents) {
  const clusters = [];
  const seen = new Set();

  // Pass 1: same period label
  const byPeriod = new Map();
  for (const ev of pastEvents) {
    const key = ev.period ?? "";
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push(ev);
  }
  for (const [period, group] of byPeriod) {
    if (group.length > 1) {
      clusters.push({ kind: "same-period", period, events: group });
      for (const e of group) seen.add(e.id);
    }
  }

  // Pass 2: sec-submissions within 45d, not already clustered
  const orphanSecSub = pastEvents
    .filter((e) => !seen.has(e.id))
    .filter((e) => e.provenance === "sec-submissions")
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  let i = 0;
  while (i < orphanSecSub.length) {
    const anchor = orphanSecSub[i];
    const group = [anchor];
    let j = i + 1;
    while (j < orphanSecSub.length) {
      if (daysBetween(anchor.eventDate, orphanSecSub[j].eventDate) <= CLOSE_WINDOW_DAYS) {
        group.push(orphanSecSub[j]);
        j++;
      } else {
        break;
      }
    }
    if (group.length > 1) {
      clusters.push({ kind: "sec-submissions-cluster", period: anchor.period, events: group });
      for (const e of group) seen.add(e.id);
    }
    i = j;
  }

  // Pass 3: cross-provenance close-date within 45d (fiscal-calendar offset).
  // Only pairs where the periods differ AND the years are compatible — a
  // 2024-Q4 event next to a 2025-Q1 event on close dates might be a real
  // year-boundary pair, not a dupe. Restrict to same year.
  const remaining = pastEvents
    .filter((e) => !seen.has(e.id))
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  for (let a = 0; a < remaining.length; a++) {
    if (seen.has(remaining[a].id)) continue;
    const group = [remaining[a]];
    const yearA = (remaining[a].period ?? "").match(/FY(\d{4})/)?.[1];
    for (let b = a + 1; b < remaining.length; b++) {
      if (seen.has(remaining[b].id)) continue;
      if (daysBetween(remaining[a].eventDate, remaining[b].eventDate) > CLOSE_WINDOW_DAYS) break;
      const yearB = (remaining[b].period ?? "").match(/FY(\d{4})/)?.[1];
      if (yearA && yearB && yearA !== yearB) continue;
      group.push(remaining[b]);
    }
    if (group.length > 1) {
      clusters.push({ kind: "close-date-cross-provenance", period: remaining[a].period, events: group });
      for (const e of group) seen.add(e.id);
    }
  }

  return clusters;
}

// Return the canonical merged event for a group.
function mergeGroup(group) {
  // Pick the winner: highest provenance rank; tiebreak by metric count desc.
  const ordered = group
    .slice()
    .sort(
      (a, b) =>
        rank(b.provenance) - rank(a.provenance) ||
        (b.metrics?.length ?? 0) - (a.metrics?.length ?? 0) ||
        a.eventDate.localeCompare(b.eventDate),
    );
  const winner = ordered[0];
  const others = ordered.slice(1);

  // Merge metrics: union by key. Winner keeps its own metrics; for each
  // other metric key not already present, add it. If a losing event has
  // a HIGHER-ranked provenance than the winner's metric-source (rare —
  // only when the same key exists in both), swap and record the swap.
  const mergedMetrics = new Map();
  for (const m of winner.metrics ?? []) mergedMetrics.set(m.key, { m, from: winner });

  const superseded = [];
  for (const other of others) {
    for (const m of other.metrics ?? []) {
      const cur = mergedMetrics.get(m.key);
      if (!cur) {
        mergedMetrics.set(m.key, { m, from: other });
        continue;
      }
      // Same key conflict — provenance rank decides.
      if (rank(other.provenance) > rank(cur.from.provenance)) {
        // Loser: current metric value goes to superseded.
        if (cur.m.actual?.value != null) {
          superseded.push({
            key: cur.m.key,
            value: cur.m.actual.value,
            unit: cur.m.actual.unit,
            source: cur.m.actual.source?.label ?? null,
            from_provenance: cur.from.provenance ?? null,
            from_event_id: cur.from.id,
          });
        }
        mergedMetrics.set(m.key, { m, from: other });
      } else if (m.actual?.value != null && m.actual.value !== cur.m.actual?.value) {
        // Winner keeps; loser noted.
        superseded.push({
          key: m.key,
          value: m.actual.value,
          unit: m.actual.unit,
          source: m.actual.source?.label ?? null,
          from_provenance: other.provenance ?? null,
          from_event_id: other.id,
        });
      }
    }
  }

  // Earliest report date wins.
  const earliestDate = group
    .slice()
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate))[0].eventDate;

  const provenanceMerged = [
    ...new Set(group.map((e) => e.provenance ?? "unknown")),
  ].sort();

  return {
    ...winner,
    eventDate: earliestDate,
    metrics: [...mergedMetrics.values()].map((v) => v.m),
    provenance_merged: provenanceMerged,
    ...(superseded.length > 0 ? { superseded } : {}),
  };
}

async function main() {
  console.log(`dedupe-events · dry=${DRY}`);
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  let totalShardsChanged = 0;
  let totalEventsRemoved = 0;
  const perTicker = [];

  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const raw = await fs.readFile(p, "utf-8");
    const j = JSON.parse(raw);
    const isWrapped = !Array.isArray(j) && Array.isArray(j.events);
    const originalEvents = isWrapped ? j.events : j;
    const ticker = isWrapped ? j.ticker : originalEvents[0]?.ticker;

    const past = originalEvents.filter((e) => e.eventDate);
    const future = originalEvents.filter((e) => !e.eventDate);
    const clusters = clusterForMerge(past);
    if (clusters.length === 0) continue;

    const removeIds = new Set();
    const addEvents = [];
    for (const c of clusters) {
      const merged = mergeGroup(c.events);
      for (const e of c.events) removeIds.add(e.id);
      addEvents.push(merged);
    }
    const newPast = past.filter((e) => !removeIds.has(e.id)).concat(addEvents);
    const newEvents = [...newPast, ...future];
    const removedCount = past.length - newPast.length;
    totalEventsRemoved += removedCount;
    totalShardsChanged++;
    perTicker.push({
      ticker,
      before: past.length,
      after: newPast.length,
      removed: removedCount,
      clusters: clusters.length,
    });

    if (!DRY) {
      const body = isWrapped
        ? { ...j, events: newEvents }
        : newEvents;
      await fs.writeFile(p, JSON.stringify(body, null, 2));
    }
  }

  perTicker.sort((a, b) => b.removed - a.removed);
  console.log(`\nShards changed: ${totalShardsChanged}`);
  console.log(`Events removed: ${totalEventsRemoved}\n`);
  console.log("ticker         before after removed clusters");
  console.log("-".repeat(55));
  for (const r of perTicker) {
    console.log(
      r.ticker.padEnd(14) +
        " " +
        String(r.before).padStart(6) +
        " " +
        String(r.after).padStart(5) +
        " " +
        String(r.removed).padStart(7) +
        " " +
        String(r.clusters).padStart(8),
    );
  }

  // Optionally sync the (gitignored) monolith so any legacy local reader
  // stays consistent. Shards are canonical — when earnings.json is absent
  // we skip cleanly instead of erroring.
  if (!DRY) {
    let mono;
    try {
      mono = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));
    } catch {
      mono = null;
    }
    if (mono) {
      console.log("\nRebuilding data/earnings.json from cleaned shards…");
      const fresh = [];
      for (const f of files) {
        const raw = await fs.readFile(path.join(EVENTS_DIR, f), "utf-8");
        const j = JSON.parse(raw);
        const evs = Array.isArray(j) ? j : j.events ?? [];
        fresh.push(...evs);
      }
      mono.events = fresh;
      mono.lastUpdated = new Date().toISOString();
      await fs.writeFile(EARNINGS, JSON.stringify(mono, null, 2));
      console.log(`✓ wrote ${EARNINGS} (${fresh.length} events)`);
    } else {
      console.log(
        "\n(earnings.json absent — shards are canonical, skipping monolith sync.)",
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
