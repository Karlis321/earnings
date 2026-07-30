#!/usr/bin/env node
/**
 * For every operating entity that has NO shard file, create a minimal
 * shard so the ticker page renders. Populates:
 *   - An "upcoming" event shell with scheduledDate = ~90 days from
 *     today (rough estimator; refined by the next real cron)
 *   - sourceLink pointing at Yahoo's earnings-history for that symbol
 *   - Yahoo v1 search-news items on the shell so at least news shows
 *
 * Cross-listing inheritance: if a sibling of the same companyId
 * already has a rich shard, copy those past events (rewriting ticker
 * + resetting reactions) instead of creating an empty shell.
 *
 *   node scripts/create-empty-shard-fill.mjs [--dry]
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
const UA = "Mozilla/5.0 (create-empty-shard-fill)";
const CONCURRENCY = 8;
const NEWS_PER_TICKER = 5;
const REQUEST_TIMEOUT_MS = 12_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}
function newsId(s) {
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
  } catch (e) { return { error: e.message ?? "network" }; }
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
  console.log(`create-empty-shard-fill · dry=${DRY}`);
  const nowIso = new Date().toISOString();
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  const byTicker = new Map();
  for (const e of entities) byTicker.set(e.ticker, e);

  const bySibling = new Map();
  for (const e of entities) {
    if (!e.companyId) continue;
    if (!bySibling.has(e.companyId)) bySibling.set(e.companyId, []);
    bySibling.get(e.companyId).push(e);
  }

  const noShardTargets = [];
  for (const e of entities) {
    if (e.securityType !== "operating") continue;
    const p = path.join(EVENTS_DIR, tickerSlug(e.ticker) + ".json");
    if (!fssync.existsSync(p)) noShardTargets.push(e);
  }
  console.log(`No-shard operating targets: ${noShardTargets.length}`);

  const rollup = {
    schema: "create-empty-shard-fill/v1",
    generatedAt: nowIso,
    totals: {
      targets: noShardTargets.length,
      inherited: 0,
      fetched: 0,
      shardsWritten: 0,
      newsAttached: 0,
      noNews: 0,
      noYahooSymbol: 0,
    },
  };

  let processed = 0;
  await pool(noShardTargets, CONCURRENCY, async (entity) => {
    processed++;
    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    const siblings = (entity.companyId ? bySibling.get(entity.companyId) : []) || [];
    const richSibling = siblings.find((s) => {
      if (s.ticker === entity.ticker) return false;
      const sp = path.join(EVENTS_DIR, tickerSlug(s.ticker) + ".json");
      if (!fssync.existsSync(sp)) return false;
      try {
        const sj = JSON.parse(fssync.readFileSync(sp, "utf-8"));
        const sevs = Array.isArray(sj) ? sj : sj.events ?? [];
        return sevs.some((x) => x.eventDate);
      } catch { return false; }
    });

    if (richSibling) {
      // Copy events from sibling.
      const sp = path.join(EVENTS_DIR, tickerSlug(richSibling.ticker) + ".json");
      const sj = JSON.parse(fssync.readFileSync(sp, "utf-8"));
      const sevs = Array.isArray(sj) ? sj : sj.events ?? [];
      const cloned = sevs.map((ev) => ({
        ...ev,
        id: hashId(`${entity.ticker}_${ev.eventDate ?? ev.scheduledDate}_${ev.period ?? ""}`),
        ticker: entity.ticker,
        reaction: {
          benchmark: entity.benchmark ?? ev.reaction?.benchmark ?? "",
          baselineDate: null,
          baselineClose: null,
          points: (ev.reaction?.points ?? []).map((p) => ({
            horizon: p.horizon,
            absReturn: null,
            excessReturn: null,
            benchmark: entity.benchmark ?? "",
            computedAt: null,
            populatesOn: p.populatesOn,
            status: "pending",
          })),
        },
        sourceLink: entity.yahooSymbol
          ? {
              url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/earnings-history`,
              kind: "fallback",
            }
          : ev.sourceLink,
      }));
      if (!DRY) fssync.writeFileSync(shardPath, JSON.stringify({ events: cloned }, null, 2));
      rollup.totals.inherited++;
      rollup.totals.shardsWritten++;
      return;
    }

    if (!entity.yahooSymbol) {
      rollup.totals.noYahooSymbol++;
      return;
    }

    // Fetch news to seed the empty shard.
    const nr = await yahooNews(entity.yahooSymbol);
    rollup.totals.fetched++;
    const newsItems = (nr.news ?? []).map((n) => ({
      id: newsId(`${entity.ticker}_${n.link}`),
      kind: "news",
      source: n.publisher ?? "Yahoo News",
      title: n.title,
      url: n.link,
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : nowIso,
      capturedAt: nowIso,
      provenance: "yahoo-search-news",
      articleType: n.type === "STORY" ? "news" : (n.type ?? "news").toLowerCase(),
      language: "en",
    })).filter((it) => it.url && it.title);

    if (newsItems.length === 0) rollup.totals.noNews++;
    else rollup.totals.newsAttached += newsItems.length;

    // Upcoming shell: ~90 days from today.
    const in90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const shellId = hashId(`${entity.ticker}_${in90}_upcoming`);
    const shell = {
      id: shellId,
      ticker: entity.ticker,
      kind: "earnings",
      period: null,
      scheduledDate: in90,
      eventDate: null,
      timing: null,
      expectation: "unset",
      guidanceMove: null,
      freshness: "fresh",
      provenance: "estimator-fallback-shell",
      provenanceAsOf: nowIso,
      metrics: [],
      guidance: [],
      reaction: {
        benchmark: entity.benchmark ?? "",
        baselineDate: null,
        baselineClose: null,
        points: [
          { horizon: "d1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "d3", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "w1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "m1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
        ],
      },
      sources: {
        windowStart: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
        windowEnd: new Date().toISOString().slice(0, 10),
        capturedAt: nowIso,
        items: newsItems,
        engineStatus: newsItems.length > 0
          ? [{ engine: "yahoo-search-news", ok: true, itemsFound: newsItems.length, checkedAt: nowIso }]
          : [],
      },
      sourceLink: {
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/earnings-history`,
        kind: "fallback",
      },
    };

    if (!DRY) fssync.writeFileSync(shardPath, JSON.stringify({ events: [shell] }, null, 2));
    rollup.totals.shardsWritten++;

    if (processed % 50 === 0 || processed === noShardTargets.length) {
      console.log(`  ${processed}/${noShardTargets.length} · shards=${rollup.totals.shardsWritten} · inherited=${rollup.totals.inherited} · news=${rollup.totals.newsAttached}`);
    }
  });

  console.log(`\n=== create-empty-shard-fill ===`);
  console.log(`No-shard targets:       ${rollup.totals.targets}`);
  console.log(`Inherited from sibling: ${rollup.totals.inherited}`);
  console.log(`Fetched Yahoo news:     ${rollup.totals.fetched}`);
  console.log(`Shards written:         ${rollup.totals.shardsWritten}`);
  console.log(`News items attached:    ${rollup.totals.newsAttached}`);
  console.log(`Empty (no yahoo news):  ${rollup.totals.noNews}`);
  console.log(`No yahooSymbol:         ${rollup.totals.noYahooSymbol}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "create-empty-shard-fill.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/create-empty-shard-fill.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
