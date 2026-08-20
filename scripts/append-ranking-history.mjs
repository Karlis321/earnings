#!/usr/bin/env node
/**
 * Phase 3.1 — daily append to data/ranking-history.jsonl.
 *
 * Reads data/ranking.json (assumes run-ranking.mjs just wrote it in
 * the same refresh-universe pass) and appends one row per ticker
 * per day. Idempotent — if today's row already exists for a
 * ticker, that ticker is skipped this run. Old rows are never
 * mutated; new rows only append.
 *
 * Output shape (one JSON object per line):
 *   {"date":"2026-08-20","ticker":"AAPL US","composite":0.42,"rank":15,"reaction":6.5,"surprise":null,"trend":11.2}
 *
 * Consumed by /s/[ticker] composite sparkline (Phase 3.2) and
 * potentially future momentum/decay analyses.
 *
 * Usage:
 *   node scripts/append-ranking-history.mjs
 *   node scripts/append-ranking-history.mjs --dry
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const RANKING_PATH = path.join(ROOT, "data", "ranking.json");
const HISTORY_PATH = path.join(ROOT, "data", "ranking-history.jsonl");

const DRY = process.argv.includes("--dry");

async function loadExistingKeys() {
  // History can grow large — stream it line-by-line and pluck
  // (date, ticker) tuples for dedup.
  const keys = new Set();
  if (!fs.existsSync(HISTORY_PATH)) return keys;
  const stream = fs.createReadStream(HISTORY_PATH, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.date && row?.ticker) keys.add(`${row.date}:${row.ticker}`);
    } catch {
      // Skip malformed lines — jsonl is append-only so a single
      // corrupt row shouldn't stop the whole scan.
    }
  }
  return keys;
}

async function main() {
  if (!fs.existsSync(RANKING_PATH)) {
    console.error("::error::data/ranking.json missing — run run-ranking.mjs first");
    process.exit(1);
  }
  const ranking = JSON.parse(fs.readFileSync(RANKING_PATH, "utf-8"));
  const rows = Array.isArray(ranking?.rows) ? ranking.rows : [];
  if (rows.length === 0) {
    console.error("::error::ranking has 0 rows");
    process.exit(1);
  }

  // Use ranking.generatedAt's date (UTC) as the history stamp —
  // ensures midnight-boundary edge cases stay consistent with the
  // ranking snapshot itself.
  const dateIso = (ranking.generatedAt ?? new Date().toISOString()).slice(
    0,
    10,
  );

  const existing = await loadExistingKeys();
  const newLines = [];
  let skipped = 0;

  for (const r of rows) {
    const key = `${dateIso}:${r.ticker}`;
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    const entry = {
      date: dateIso,
      ticker: r.ticker,
      composite: r.compositeScore,
      rank: r.rank,
      reaction: r.components?.reaction?.raw ?? null,
      surprise: r.components?.surprise?.raw ?? null,
      trend: r.components?.trend?.raw ?? null,
    };
    newLines.push(JSON.stringify(entry));
  }

  console.log(
    `append-ranking-history: date=${dateIso} · rows=${rows.length} · new=${newLines.length} · skipped(existing)=${skipped}`,
  );

  if (DRY) {
    console.log("--dry — no write");
    return;
  }
  if (newLines.length === 0) {
    console.log("nothing to append (all rows already recorded for this date)");
    return;
  }
  fs.appendFileSync(HISTORY_PATH, newLines.join("\n") + "\n");
  const total = existing.size + newLines.length;
  console.log(
    `✓ appended ${newLines.length} lines to data/ranking-history.jsonl (total: ${total})`,
  );
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
