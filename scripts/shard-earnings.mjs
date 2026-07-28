#!/usr/bin/env node
/**
 * Shard data/earnings.json (10+ MB monolith) into per-ticker shards:
 *
 *   data/events/<TICKER_SLUG>.json   — {schema, ticker, events: EventRecord[]}
 *   data/events-index.json           — {schema, updatedAt, entries: [...]}
 *
 * Grid pages read only the ~100 KB index; detail pages read one shard.
 *
 *   node scripts/shard-earnings.mjs
 *   node scripts/shard-earnings.mjs --dry
 *
 * The monolithic earnings.json stays in place as a backwards-compat
 * fallback so anything still calling store.readEarnings() gets the
 * whole snapshot. Cron writes to both.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const INDEX_PATH = path.join(ROOT, "data", "events-index.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;

// "HBM US" -> "HBM_US"; "AAPL34 BZ" -> "AAPL34_BZ"; "005930 KS" -> "005930_KS"
// Filesystem-safe, preserves the Bloomberg suffix.
function tickerSlug(ticker) {
  return ticker.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

function buildIndexEntry(ticker, events, entity) {
  const past = events.filter((e) => e.eventDate);
  const future = events.filter((e) => !e.eventDate);
  past.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  future.sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
  const latest = past[0] ?? null;
  const nextEvent = future[0] ?? null;
  // Surprise from latest past event's first EPS metric.
  let lastSurprisePct = null;
  if (latest) {
    const epsMetric = latest.metrics?.find((m) => /eps/i.test(m.key ?? ""));
    lastSurprisePct = epsMetric?.surprisePct ?? null;
  }
  return {
    ticker,
    count: events.length,
    lastEventId: latest?.id ?? null,
    lastEventDate: latest?.eventDate ?? null,
    lastPeriod: latest?.period ?? null,
    lastSurprisePct,
    nextEventId: nextEvent?.id ?? null,
    nextScheduled: nextEvent?.scheduledDate ?? null,
    nextPeriod: nextEvent?.period ?? null,
    // freshness: "stale" is the marker the estimator sets on synthesized shells.
    nextIsEstimated: !!nextEvent && nextEvent.freshness === "stale",
    nextCadence: nextEvent?.cadence,
    sourceCount: entity?.sourceCount ?? 0,
    guidanceMove: latest?.guidanceMove ?? null,
    freshness: latest?.freshness ?? "never",
  };
}

async function main() {
  console.log(`shard-earnings · dry=${DRY}`);
  const [snapRaw, regRaw] = await Promise.all([
    fs.readFile(EARNINGS, "utf-8"),
    fs.readFile(REGISTRY, "utf-8"),
  ]);
  const snap = JSON.parse(snapRaw);
  const reg = JSON.parse(regRaw);
  const entityByTicker = new Map(reg.entities.map((e) => [e.ticker, e]));

  // Group events by ticker
  const byTicker = new Map();
  for (const ev of snap.events) {
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker).push(ev);
  }

  console.log(`Events: ${snap.events.length} across ${byTicker.size} tickers`);

  const entries = [];
  let totalShardBytes = 0;
  const shards = [];
  for (const [ticker, events] of byTicker) {
    entries.push(buildIndexEntry(ticker, events, entityByTicker.get(ticker)));
    const shard = {
      schema: "events-shard/v1",
      ticker,
      events,
    };
    const body = JSON.stringify(shard, null, 2);
    totalShardBytes += body.length;
    shards.push({ slug: tickerSlug(ticker), body });
  }

  // Also include entities that have no events yet — they still deserve
  // an index entry (so the grid shows them with next/last as null).
  for (const e of reg.entities) {
    if (byTicker.has(e.ticker)) continue;
    entries.push({
      ticker: e.ticker,
      count: 0,
      lastEventId: null,
      lastEventDate: null,
      lastPeriod: null,
      lastSurprisePct: null,
      nextEventId: null,
      nextScheduled: null,
      nextPeriod: null,
      nextIsEstimated: false,
      sourceCount: e.sourceCount ?? 0,
      guidanceMove: null,
      freshness: "never",
    });
  }

  const index = {
    schema: "events-index/v1",
    updatedAt: new Date().toISOString(),
    entries,
  };
  const indexBody = JSON.stringify(index, null, 2);

  console.log(
    `\nIndex: ${entries.length} entries · ${(indexBody.length / 1024).toFixed(1)} KB`,
  );
  console.log(
    `Shards: ${shards.length} files · total ${(totalShardBytes / 1024 / 1024).toFixed(2)} MB · avg ${(totalShardBytes / shards.length / 1024).toFixed(1)} KB each`,
  );

  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }

  await fs.mkdir(EVENTS_DIR, { recursive: true });
  for (const { slug, body } of shards) {
    await fs.writeFile(path.join(EVENTS_DIR, `${slug}.json`), body);
  }
  await fs.writeFile(INDEX_PATH, indexBody);
  console.log(`\n✓ wrote ${shards.length} shards to ${EVENTS_DIR}`);
  console.log(`✓ wrote ${INDEX_PATH}`);
  console.log(
    `\nNote: data/earnings.json is left in place as a backwards-compat fallback.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
