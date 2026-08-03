#!/usr/bin/env node
/**
 * Collapse same-period duplicate past events into one canonical
 * entry. Root cause: mixed sources land at ingest — Yahoo stamps
 * FY quarter-end (2025-12-31 for FY2025 Q4) while SEC or a sibling
 * inherit stamps the real fiscal filing date (2026-02-12). Both
 * carry the same period label, which trips the same-period
 * duplicate invariant.
 *
 * Rule: for each (ticker, period) group with >1 events, keep the
 * one with the most populated actuals. Tie-break rules in order:
 *   1. Higher `actuals` count wins.
 *   2. sourceLink.kind === "filing" beats "fallback".
 *   3. Non-quarter-end eventDate beats quarter-end (fiscal reporting
 *      dates are usually mid-month, quarter-end is Yahoo's
 *      placeholder).
 *   4. eventId presence beats missing.
 *   5. Later fetchedAt on any metric beats earlier.
 *
 *   node scripts/dedup-same-period.mjs [--dry]
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

function isQuarterEnd(iso) {
  if (!iso || iso.length < 10) return false;
  const md = iso.slice(5, 10);
  return md === "03-31" || md === "06-30" || md === "09-30" || md === "12-31";
}
function actualsCount(ev) {
  return (ev.metrics ?? []).filter((m) => m.actual?.value != null).length;
}
function latestFetchedAt(ev) {
  let latest = "";
  for (const m of ev.metrics ?? []) {
    const t = m.actual?.fetchedAt ?? "";
    if (t > latest) latest = t;
  }
  return latest;
}
function scoreEvent(ev) {
  return [
    actualsCount(ev),
    ev.sourceLink?.kind === "filing" ? 1 : 0,
    isQuarterEnd(ev.eventDate) ? 0 : 1,
    ev.eventId ? 1 : 0,
    latestFetchedAt(ev),
  ];
}
function betterOf(a, b) {
  const sa = scoreEvent(a);
  const sb = scoreEvent(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] > sb[i]) return a;
    if (sa[i] < sb[i]) return b;
  }
  return a;
}

async function main() {
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const audit = {
    schema: "dedup-same-period/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    dedups: [],
  };
  let shardsTouched = 0;
  let dupesRemoved = 0;
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const raw = JSON.parse(fssync.readFileSync(p, "utf-8"));
    const wrapped = !Array.isArray(raw);
    const events = wrapped ? raw.events ?? [] : raw;

    // Group past events by period
    const groups = new Map();
    for (const ev of events) {
      if (!ev.eventDate) continue;
      if (!ev.period) continue;
      const arr = groups.get(ev.period) ?? [];
      arr.push(ev);
      groups.set(ev.period, arr);
    }

    const removeSet = new Set();
    for (const [period, arr] of groups) {
      if (arr.length < 2) continue;
      // Pick the winner
      const winner = arr.reduce((a, b) => betterOf(a, b));
      for (const ev of arr) {
        if (ev !== winner) {
          removeSet.add(ev);
          audit.dedups.push({
            shard: f,
            period,
            kept: {
              eventDate: winner.eventDate,
              actuals: actualsCount(winner),
              sourceLinkKind: winner.sourceLink?.kind ?? null,
            },
            dropped: {
              eventDate: ev.eventDate,
              actuals: actualsCount(ev),
              sourceLinkKind: ev.sourceLink?.kind ?? null,
            },
          });
        }
      }
    }
    if (removeSet.size === 0) continue;
    shardsTouched++;
    dupesRemoved += removeSet.size;
    const cleaned = events.filter((ev) => !removeSet.has(ev));
    if (!DRY) {
      const out = wrapped ? { ...raw, events: cleaned } : cleaned;
      await fs.writeFile(p, JSON.stringify(out, null, 2));
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "dedup-same-period.json"),
    JSON.stringify(audit, null, 2),
  );
  console.log(`=== dedup-same-period ===`);
  console.log(`  shards touched:   ${shardsTouched}`);
  console.log(`  duplicates dropped: ${dupesRemoved}`);
  for (const d of audit.dedups) {
    console.log(
      `  ${d.shard} · ${d.period} · kept eventDate=${d.kept.eventDate} (${d.kept.actuals} actuals, ${d.kept.sourceLinkKind}) · dropped eventDate=${d.dropped.eventDate} (${d.dropped.actuals} actuals, ${d.dropped.sourceLinkKind})`,
    );
  }
  console.log(`  audit → scripts/audits/dedup-same-period.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
