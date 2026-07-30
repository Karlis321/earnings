#!/usr/bin/env node
/**
 * My attach-yahoo-news.mjs + create-empty-shard-fill.mjs wrote source
 * items with a `title` field. The SourceItem type in
 * frontend/lib/types.ts expects `headline`. Downstream:
 *   SourcesPanel → SourceItemCard → ShareEmailButton →
 *     shareArticleProps(item.headline, ...) → headline.slice(0, 100)
 * → 'Cannot read properties of undefined (reading slice)' throw.
 *
 * Sweep: rename `title` → `headline` on every source item that has a
 * title but no headline. Keep `title` around too for backward
 * compatibility (some code may already read it) but ensure headline
 * is always present.
 *
 *   node scripts/fix-source-item-headlines.mjs [--dry]
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

async function main() {
  const rollup = {
    schema: "fix-source-item-headlines/v1",
    generatedAt: new Date().toISOString(),
    totals: { shardsRead: 0, shardsWritten: 0, itemsPatched: 0, itemsAlreadyOk: 0 },
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
      const items = e.sources?.items;
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (typeof it.headline === "string" && it.headline.length > 0) {
          rollup.totals.itemsAlreadyOk++;
          continue;
        }
        if (typeof it.title === "string" && it.title.length > 0) {
          it.headline = it.title;
          rollup.totals.itemsPatched++;
        }
      }
    }

    const next = JSON.stringify(events);
    if (next !== original && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`=== fix-source-item-headlines ===`);
  console.log(`Shards read:     ${rollup.totals.shardsRead}`);
  console.log(`Shards written:  ${rollup.totals.shardsWritten}`);
  console.log(`Items patched:   ${rollup.totals.itemsPatched}`);
  console.log(`Items already OK: ${rollup.totals.itemsAlreadyOk}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "fix-source-item-headlines.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/fix-source-item-headlines.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
