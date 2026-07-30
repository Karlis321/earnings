#!/usr/bin/env node
/**
 * My earlier attach-yahoo-news.mjs and create-empty-shard-fill.mjs
 * stamped source items with provenance: "yahoo-search-news", which
 * is NOT in the Provenance union type (regulatory | ir-page | wire
 * | news | social | independent). ProvenanceChip looks it up in a
 * closed record and reads .cls on undefined, throwing at SSR of
 * /s/[ticker] and /s/[ticker]/e/[eventId] — HTTP 500 across the site.
 *
 * Rewrite every source item's provenance from "yahoo-search-news" →
 * "wire" (semantically correct — Yahoo aggregates wire services).
 *
 *   node scripts/fix-news-provenance.mjs [--dry]
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
const VALID = new Set(["regulatory", "ir-page", "wire", "news", "social", "independent"]);

async function main() {
  console.log(`fix-news-provenance · dry=${DRY}`);
  const rollup = {
    schema: "fix-news-provenance/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      shardsRead: 0,
      shardsWritten: 0,
      itemsFixed: 0,
      alreadyValid: 0,
      invalidValuesFound: {},
    },
  };

  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(p, "utf-8")); } catch { continue; }
    rollup.totals.shardsRead++;
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const original = JSON.stringify(events);

    for (const e of events) {
      for (const it of (e.sources?.items ?? [])) {
        const prov = it.provenance;
        if (VALID.has(prov)) { rollup.totals.alreadyValid++; continue; }
        rollup.totals.invalidValuesFound[prov] = (rollup.totals.invalidValuesFound[prov] ?? 0) + 1;
        it.provenance = "wire";
        rollup.totals.itemsFixed++;
      }
    }

    const next = JSON.stringify(events);
    if (next !== original && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== fix-news-provenance ===`);
  console.log(`Shards read:      ${rollup.totals.shardsRead}`);
  console.log(`Shards written:   ${rollup.totals.shardsWritten}`);
  console.log(`Items fixed:      ${rollup.totals.itemsFixed}`);
  console.log(`Already valid:    ${rollup.totals.alreadyValid}`);
  console.log(`Bad values found: ${JSON.stringify(rollup.totals.invalidValuesFound)}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "fix-news-provenance.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/fix-news-provenance.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
