#!/usr/bin/env node
/**
 * Apply a guidance payload to a ticker+period's event on its shard.
 * Called by /earnings Step 3 (Guidance) to persist company-issued
 * forward guidance onto event.guidance[]. Kept as a script (per the
 * sanctioned-tools rule in .claude/commands/earnings.md) so /earnings
 * never writes shard files via `node -e`.
 *
 *   node scripts/apply-guidance.mjs <TICKER> <PERIOD> <payload.json>
 *
 * <payload.json> must be a JSON array of GuidanceEntry objects (see
 * frontend/lib/types.ts):
 *   [
 *     {
 *       key, displayLabel, period, basis, version, supersededById,
 *       move, low, high, midpoint
 *     }, ...
 *   ]
 *
 * Behavior:
 *   - Finds the event on <TICKER>'s shard matching <PERIOD>
 *     (or matching event.id if PERIOD is an id).
 *   - Appends the payload entries to event.guidance (existing entries
 *     with the same key are replaced, not duplicated).
 *   - Validates every entry has key + displayLabel + period + basis.
 *   - Exits 0 on success, 1 on failure (with descriptive message).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const VALID_MOVES = new Set(["raised", "held", "cut", "initiated", "withdrawn", null]);

const [, , TICKER, PERIOD, PAYLOAD_PATH] = process.argv;
if (!TICKER || !PERIOD || !PAYLOAD_PATH) {
  console.error("Usage: node scripts/apply-guidance.mjs <TICKER> <PERIOD> <payload.json>");
  process.exit(1);
}

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

function validFact(f) {
  if (f === null) return true;
  return f && typeof f.value === "number" && typeof f.unit === "string" && f.source && typeof f.source.url === "string";
}

async function main() {
  const shardPath = path.join(EVENTS_DIR, tickerSlug(TICKER) + ".json");
  let shard;
  try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); }
  catch { console.error(`::error::shard not found: ${shardPath}`); process.exit(1); }

  const wrapped = !Array.isArray(shard);
  const events = wrapped ? shard.events ?? [] : shard;
  const target = events.find((e) => e.period === PERIOD || e.id === PERIOD);
  if (!target) {
    console.error(`::error::no event matching period="${PERIOD}" (or id) on ${TICKER}`);
    process.exit(1);
  }

  let payload;
  try { payload = JSON.parse(await fs.readFile(PAYLOAD_PATH, "utf-8")); }
  catch (e) { console.error(`::error::cannot read payload ${PAYLOAD_PATH}: ${e.message}`); process.exit(1); }
  if (!Array.isArray(payload)) {
    console.error(`::error::payload must be a JSON array of GuidanceEntry`);
    process.exit(1);
  }

  const cleaned = [];
  const errors = [];
  for (const g of payload) {
    if (!g.key || !g.displayLabel || !g.period || !g.basis) { errors.push(`missing key/displayLabel/period/basis on ${g.key ?? "?"}`); continue; }
    if (typeof g.version !== "number") { errors.push(`${g.key}: version must be a number`); continue; }
    if (!VALID_MOVES.has(g.move ?? null)) { errors.push(`${g.key}: invalid move "${g.move}"`); continue; }
    if (!validFact(g.low ?? null) || !validFact(g.high ?? null) || !validFact(g.midpoint ?? null)) {
      errors.push(`${g.key}: low/high/midpoint must be null or a valid Fact`);
      continue;
    }
    cleaned.push({
      key: g.key,
      displayLabel: g.displayLabel,
      period: g.period,
      basis: g.basis,
      version: g.version,
      supersededById: g.supersededById ?? null,
      move: g.move ?? null,
      low: g.low ?? null,
      high: g.high ?? null,
      midpoint: g.midpoint ?? null,
    });
  }
  if (errors.length > 0) {
    console.error(`::error::${errors.length} payload entries rejected:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  const existing = Array.isArray(target.guidance) ? target.guidance : [];
  const byKey = new Map(existing.map((g) => [g.key, g]));
  for (const g of cleaned) byKey.set(g.key, g);
  target.guidance = [...byKey.values()];

  const body = wrapped ? { ...shard, events } : events;
  await fs.writeFile(shardPath, JSON.stringify(body, null, 2));
  console.log(`✓ wrote ${cleaned.length} guidance entries to ${TICKER} · ${target.period} @ ${target.eventDate}`);
  console.log(`  ${cleaned.slice(0, 5).map((g) => g.key).join(", ")}${cleaned.length > 5 ? ", …" : ""}`);
}

main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
