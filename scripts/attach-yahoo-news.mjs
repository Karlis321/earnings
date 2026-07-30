#!/usr/bin/env node
/**
 * Attach news items from Yahoo's per-ticker news feed to the LATEST
 * past event on each shard. Approximates the daily cron's news
 * fanout (which is 50+ Google News RSS feeds → Vercel-only), so
 * every ticker gets at least *some* fresh news source items.
 *
 * Yahoo v1 search endpoint returns news per ticker:
 *   https://query1.finance.yahoo.com/v1/finance/search?q={symbol}&newsCount=5
 *
 * Attach rule: the ticker's most recently reported event
 * (max eventDate). If none, skip. Items dedupe by URL — an existing
 * source item with the same URL is not duplicated.
 *
 *   node scripts/attach-yahoo-news.mjs [--dry] [--limit=N]
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

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;

const UA = "Mozilla/5.0 (attach-yahoo-news)";
const CONCURRENCY = 8;
const NEWS_PER_TICKER = 5;
const REQUEST_TIMEOUT_MS = 12_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `src-${Math.abs(h).toString(36).slice(0, 8)}`;
}

async function yahooNews(symbol) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=${NEWS_PER_TICKER}&quotesCount=0`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return { news: j?.news ?? [] };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`attach-yahoo-news · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT} concurrency=${CONCURRENCY}`);
  const now = new Date();
  const nowIso = now.toISOString();

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter(
    (e) => e.securityType === "operating" && typeof e.yahooSymbol === "string" && e.yahooSymbol,
  );
  const targets = entities.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} operating entities with Yahoo symbols`);

  const rollup = {
    schema: "attach-yahoo-news/v1",
    generatedAt: nowIso,
    totals: {
      fetched: 0,
      fetchErrors: 0,
      empty: 0,
      shardsRead: 0,
      shardsWritten: 0,
      itemsAttached: 0,
      itemsDedupedSkipped: 0,
      noPastEvent: 0,
    },
  };

  let processed = 0;
  await pool(targets, CONCURRENCY, async (entity) => {
    processed++;
    const r = await yahooNews(entity.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) { rollup.totals.fetchErrors++; return; }
    const news = r.news ?? [];
    if (news.length === 0) { rollup.totals.empty++; return; }

    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { return; }
    rollup.totals.shardsRead++;
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;

    // Latest past event.
    const past = events
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
    const target = past[0];
    if (!target) { rollup.totals.noPastEvent++; return; }

    if (!target.sources || typeof target.sources !== "object") {
      target.sources = { windowStart: null, windowEnd: null, capturedAt: null, items: [], engineStatus: [] };
    }
    if (!Array.isArray(target.sources.items)) target.sources.items = [];

    const existingUrls = new Set(target.sources.items.map((it) => it.url).filter(Boolean));
    let added = 0;
    for (const n of news) {
      if (!n.link || !n.title) continue;
      if (existingUrls.has(n.link)) { rollup.totals.itemsDedupedSkipped++; continue; }
      const publishedAt = n.providerPublishTime
        ? new Date(n.providerPublishTime * 1000).toISOString()
        : nowIso;
      const item = {
        id: hashId(`${entity.ticker}_${n.link}`),
        kind: "news",
        source: n.publisher ?? "Yahoo News",
        title: n.title,
        url: n.link,
        publishedAt,
        capturedAt: nowIso,
        provenance: "wire",
        articleType: n.type === "STORY" ? "news" : (n.type ?? "news").toLowerCase(),
        language: "en",
      };
      target.sources.items.push(item);
      existingUrls.add(n.link);
      added++;
      rollup.totals.itemsAttached++;
    }
    if (added > 0) {
      target.sources.capturedAt = nowIso;
      const windowEnd = new Date().toISOString().slice(0, 10);
      const windowStart = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      target.sources.windowStart = target.sources.windowStart ?? windowStart;
      target.sources.windowEnd = windowEnd;
      const es = target.sources.engineStatus ?? [];
      const found = es.find((e) => e.engine === "yahoo-search-news");
      if (found) { found.ok = true; found.itemsFound = (found.itemsFound ?? 0) + added; found.checkedAt = nowIso; }
      else es.push({ engine: "yahoo-search-news", ok: true, itemsFound: added, checkedAt: nowIso });
      target.sources.engineStatus = es;

      if (!DRY) {
        const body = wrapped ? { ...shard, events } : events;
        fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      }
      rollup.totals.shardsWritten++;
    }

    if (processed % 100 === 0 || processed === targets.length) {
      console.log(`  ${processed}/${targets.length} · items=${rollup.totals.itemsAttached} · shards=${rollup.totals.shardsWritten}`);
    }
  });

  console.log(`\n=== attach-yahoo-news ===`);
  console.log(`Fetched:              ${rollup.totals.fetched}`);
  console.log(`Fetch errors:         ${rollup.totals.fetchErrors}`);
  console.log(`Empty news:           ${rollup.totals.empty}`);
  console.log(`Shards written:       ${rollup.totals.shardsWritten}`);
  console.log(`Items attached:       ${rollup.totals.itemsAttached}`);
  console.log(`Items deduped-skipped:${rollup.totals.itemsDedupedSkipped}`);
  console.log(`No past event:        ${rollup.totals.noPastEvent}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "attach-yahoo-news.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/attach-yahoo-news.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
