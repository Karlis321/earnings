#!/usr/bin/env node
/**
 * Append today's sector-signals snapshot to data/sector-history.jsonl
 * so /themes can show week-over-week deltas on each sector card.
 *
 *   node scripts/append-sector-history.mjs [--dry]
 *
 * Behavior:
 *   - Reads data/sector-signals.json (must exist; run
 *     aggregate-by-sector.mjs first).
 *   - Extracts today's date from sector-signals.generatedAt.
 *   - For each sector in the snapshot, emits one JSONL row:
 *       { date, sector, medianReaction3d, tickerCount, newsCountAll }
 *   - Streams through existing sector-history.jsonl to skip
 *     (date, sector) pairs we've already recorded — idempotent
 *     re-runs on the same day don't duplicate.
 *
 * Consumed by /themes: reads the last ~14 days of history per sector
 * to compute a same-week delta chip on the sector card header.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SIGNALS_PATH = path.join(ROOT, "data", "sector-signals.json");
const HIST_PATH = path.join(ROOT, "data", "sector-history.jsonl");

const DRY = process.argv.includes("--dry");

async function readExistingKeys() {
  const set = new Set();
  try {
    const raw = await fs.readFile(HIST_PATH, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.date && row?.sector) set.add(row.date + "|" + row.sector);
      } catch {
        // ignore malformed row
      }
    }
  } catch {
    // file doesn't exist yet — first-run
  }
  return set;
}

async function main() {
  let signals;
  try {
    signals = JSON.parse(await fs.readFile(SIGNALS_PATH, "utf-8"));
  } catch (e) {
    console.error(
      `::error::cannot read data/sector-signals.json — run aggregate-by-sector.mjs first (${e.message})`,
    );
    process.exit(1);
  }

  const dateIso = (signals.generatedAt ?? new Date().toISOString()).slice(0, 10);
  const existing = await readExistingKeys();

  const newRows = [];
  let dupSkip = 0;
  for (const s of signals.sectors ?? []) {
    const key = dateIso + "|" + s.sector;
    if (existing.has(key)) {
      dupSkip++;
      continue;
    }
    newRows.push({
      date: dateIso,
      sector: s.sector,
      medianReaction3d: s.medianReaction3d ?? null,
      tickerCount: s.tickerCount ?? 0,
      newsCountAll: s.newsCountAll ?? 0,
    });
  }

  console.log(
    `append-sector-history · date=${dateIso} · sectors=${signals.sectors?.length ?? 0} · new=${newRows.length} · skip=${dupSkip}`,
  );

  if (newRows.length === 0) {
    console.log("nothing new to append — all sectors for today already recorded.");
    return;
  }

  if (DRY) {
    console.log("[dry] would append:");
    for (const r of newRows.slice(0, 5)) console.log("  ·", r);
    if (newRows.length > 5) console.log(`  ... +${newRows.length - 5} more`);
    return;
  }

  const lines = newRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.appendFile(HIST_PATH, lines);
  console.log(`✓ appended ${newRows.length} rows to data/sector-history.jsonl`);
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
