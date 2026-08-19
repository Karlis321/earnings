#!/usr/bin/env node
/**
 * Rebuild data/events/<TICKER_SLUG>.json shards + data/events-index.json.
 *
 * Sources of truth (in order):
 *   1. data/earnings.json monolith if present (legacy path)
 *   2. Existing data/events/*.json shards (canonical since shards-first
 *      refactor; monolith is .gitignored per CLAUDE.md)
 *
 * When run without the monolith, the script reconstitutes the corpus
 * from the shards themselves, rebuilds every shard body (schema-fresh),
 * and rewrites the index. Idempotent on a shards-only checkout.
 *
 *   node scripts/shard-earnings.mjs
 *   node scripts/shard-earnings.mjs --dry
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
  // Carry the reaction points from the latest past event into the index
  // so the sector member rows + watchlist expanded row can render a
  // compact ReactionRow strip without touching the full shard.
  const lastEventReactionPoints =
    latest?.reaction?.points && latest.reaction.points.length > 0
      ? latest.reaction.points
      : undefined;

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
    // Prefer the actual count on the latest event's sources.items,
    // falling back to the sum across all events, then the entity-level
    // count. The entity-level number is a periodically-refreshed
    // rolling counter that lags what's actually on the shard, so
    // reading from the shard directly keeps the SRC column live.
    sourceCount: (() => {
      const latestItems = latest?.sources?.items?.length ?? 0;
      if (latestItems > 0) return latestItems;
      const summed = events.reduce(
        (n, e) => n + (e.sources?.items?.length ?? 0),
        0,
      );
      if (summed > 0) return summed;
      return entity?.sourceCount ?? 0;
    })(),
    // Latest source-item timestamp across ALL events on this ticker.
    // Used by the watchlist to compute "+N new since your last visit"
    // client-side (localStorage lastSeenAt[ticker] compare). Absent
    // when no items exist. Not indexing by event because a very old
    // event can still receive fresh items via /append-sources.
    latestItemAt: (() => {
      let max = null;
      for (const e of events) {
        for (const it of e.sources?.items ?? []) {
          if (it?.time && (!max || it.time > max)) max = it.time;
        }
      }
      return max ?? undefined;
    })(),
    guidanceMove: latest?.guidanceMove ?? null,
    freshness: latest?.freshness ?? "never",
    lastEventReactionPoints,
    // Per-metric snapshot for the watchlist "Industry-specific
    // metric" column + dynamic per-metric sort. Only include metrics
    // with an actual value; skip null-actual placeholders.
    latestMetrics: (() => {
      if (!latest) return undefined;
      const out = {};
      for (const m of latest.metrics ?? []) {
        if (m.actual?.value == null || !m.key) continue;
        out[m.key] = {
          value: m.actual.value,
          unit: m.actual.unit ?? null,
          surprisePct: m.surprisePct ?? null,
          label: m.displayLabel ?? m.key,
        };
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })(),
  };
}

async function readSnapshotFromShards() {
  // Walk data/events/*.json — each shard is either {schema, ticker, events}
  // or a bare array (older writes). Reconstitute a snapshot in memory.
  let files;
  try {
    files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return { events: [] };
  }
  const events = [];
  for (const f of files) {
    const body = await fs.readFile(path.join(EVENTS_DIR, f), "utf-8");
    const parsed = JSON.parse(body);
    const evs = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    for (const ev of evs) events.push(ev);
  }
  return { schema: "earnings/v1", events };
}

async function main() {
  console.log(`shard-earnings · dry=${DRY}`);
  let snap;
  let source;
  try {
    const snapRaw = await fs.readFile(EARNINGS, "utf-8");
    snap = JSON.parse(snapRaw);
    source = "monolith";
  } catch {
    console.log("data/earnings.json absent — reconstituting from shards.");
    snap = await readSnapshotFromShards();
    source = "shards";
  }
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const entityByTicker = new Map(reg.entities.map((e) => [e.ticker, e]));
  console.log(`Source: ${source}`);

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
  if (source === "monolith") {
    console.log(
      `\nNote: data/earnings.json is the input; per CLAUDE.md it is not committed. Shards + index are canonical.`,
    );
  } else {
    console.log(
      `\nNote: rebuilt from shards. earnings.json is not touched (gitignored).`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
