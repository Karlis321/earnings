#!/usr/bin/env node
/**
 * Apply an extended-metrics payload to a ticker+period's event on
 * its shard. Called by /earnings step 3b to persist Claude's
 * extraction. Kept as a script (per the sanctioned-tools rule in
 * .claude/commands/earnings.md) so /earnings never writes shard
 * files via `node -e`.
 *
 *   node scripts/apply-extended-metrics.mjs <TICKER> <PERIOD> <payload.json>
 *
 * <payload.json> must be a JSON array of ExtendedMetricValue objects:
 *   [
 *     {
 *       key, label, unit, shape, value, low?, high?,
 *       provenance: "llm_extracted",
 *       source: { url, section, quote },
 *       extractedAt, confidence
 *     }, ...
 *   ]
 *
 * Behavior:
 *   - Finds the event on <TICKER>'s shard matching <PERIOD>
 *     (or matching event.id if PERIOD is an id).
 *   - Replaces event.extendedMetrics with the payload.
 *   - Validates every entry has key + label + provenance + source.
 *   - Exits 0 on success, 1 on failure (with descriptive message).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const [, , TICKER, PERIOD, PAYLOAD_PATH] = process.argv;
if (!TICKER || !PERIOD || !PAYLOAD_PATH) {
  console.error("Usage: node scripts/apply-extended-metrics.mjs <TICKER> <PERIOD> <payload.json>");
  process.exit(1);
}

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

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
    console.error(`::error::payload must be a JSON array of ExtendedMetricValue`);
    process.exit(1);
  }

  const cleaned = [];
  const errors = [];
  for (const m of payload) {
    if (!m.key || !m.label || !m.unit) { errors.push(`missing key/label/unit`); continue; }
    if (m.provenance !== "llm_extracted") { errors.push(`${m.key}: provenance must be "llm_extracted"`); continue; }
    if (!m.source?.url || !m.source?.quote) { errors.push(`${m.key}: source.url + source.quote required`); continue; }
    if (typeof m.confidence !== "number" || m.confidence < 0.7) {
      errors.push(`${m.key}: confidence must be >= 0.7 (got ${m.confidence})`);
      continue;
    }
    cleaned.push({
      key: m.key,
      label: m.label,
      unit: m.unit,
      shape: m.shape ?? "point",
      value: m.value ?? null,
      low: m.low ?? null,
      high: m.high ?? null,
      provenance: "llm_extracted",
      source: {
        url: m.source.url,
        section: m.source.section ?? "",
        quote: m.source.quote,
      },
      extractedAt: m.extractedAt ?? new Date().toISOString(),
      confidence: m.confidence,
    });
  }
  if (errors.length > 0) {
    console.error(`::error::${errors.length} payload entries rejected:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  target.extendedMetrics = cleaned;
  const body = wrapped ? { ...shard, events } : events;
  await fs.writeFile(shardPath, JSON.stringify(body, null, 2));
  console.log(`✓ wrote ${cleaned.length} extended metrics to ${TICKER} · ${target.period} @ ${target.eventDate}`);
  console.log(`  ${cleaned.slice(0, 5).map((m) => m.key).join(", ")}${cleaned.length > 5 ? ", …" : ""}`);
}

main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
