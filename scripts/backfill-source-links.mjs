#!/usr/bin/env node
/**
 * Ensure every event on every ticker's shard has a top-level
 * `sourceLink: { url, kind }` so the event-detail card can render
 * a working click-through to the underlying source.
 *
 * Priority order for deriving the URL when sourceLink is missing:
 *   1. First metric's actual.source.url pointing at SEC EDGAR
 *      → kind: "filing"
 *   2. First metric's actual.source.url pointing anywhere
 *      → kind: "fallback"
 *   3. Entity's yahooSymbol → https://finance.yahoo.com/quote/{sym}/financials
 *      → kind: "fallback"
 *   4. Entity's yahooSymbol → https://finance.yahoo.com/quote/{sym}/earnings-history
 *      → kind: "fallback" (for events with no metric.actual either)
 *
 *   node scripts/backfill-source-links.mjs [--dry]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

function chooseUrl(event, entity) {
  // Prefer SEC filing URLs from metric sources.
  const metricUrls = (event.metrics ?? [])
    .map((m) => m.actual?.source?.url ?? m.estimate?.source?.url ?? null)
    .filter(Boolean);
  const secUrl = metricUrls.find((u) => /sec\.gov/i.test(u));
  if (secUrl) return { url: secUrl, kind: "filing" };
  if (metricUrls.length > 0) return { url: metricUrls[0], kind: "fallback" };
  const sym = entity?.yahooSymbol;
  if (sym) {
    const enc = encodeURIComponent(sym);
    return event.eventDate
      ? { url: `https://finance.yahoo.com/quote/${enc}/earnings-history`, kind: "fallback" }
      : { url: `https://finance.yahoo.com/quote/${enc}/analysis`, kind: "fallback" };
  }
  return null;
}

async function main() {
  console.log(`backfill-source-links · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  const rollup = {
    schema: "backfill-source-links/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      shardsRead: 0,
      shardsWritten: 0,
      events: 0,
      alreadyHadLink: 0,
      linkAddedFromMetric: 0,
      linkAddedFromYahoo: 0,
      skippedNoRegistry: 0,
      skippedNoAnchor: 0,
    },
  };

  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const shardPath = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); }
    catch { continue; }
    rollup.totals.shardsRead++;
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const originalJson = JSON.stringify(events);

    for (const e of events) {
      rollup.totals.events++;
      if (e.sourceLink?.url) { rollup.totals.alreadyHadLink++; continue; }
      const entity = byTicker.get(e.ticker);
      if (!entity) { rollup.totals.skippedNoRegistry++; }
      const link = chooseUrl(e, entity);
      if (!link) { rollup.totals.skippedNoAnchor++; continue; }
      e.sourceLink = link;
      // Track the origin.
      if ((e.metrics ?? []).some((m) => m.actual?.source?.url === link.url)) {
        rollup.totals.linkAddedFromMetric++;
      } else {
        rollup.totals.linkAddedFromYahoo++;
      }
    }

    const nextJson = JSON.stringify(events);
    if (nextJson !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== backfill-source-links ===`);
  console.log(`Shards read:              ${rollup.totals.shardsRead}`);
  console.log(`Shards written:           ${rollup.totals.shardsWritten}`);
  console.log(`Events scanned:           ${rollup.totals.events}`);
  console.log(`Already had sourceLink:   ${rollup.totals.alreadyHadLink}`);
  console.log(`Added from metric url:    ${rollup.totals.linkAddedFromMetric}`);
  console.log(`Added from Yahoo anchor:  ${rollup.totals.linkAddedFromYahoo}`);
  console.log(`Skipped (no anchor):      ${rollup.totals.skippedNoAnchor}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "backfill-source-links.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/backfill-source-links.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
