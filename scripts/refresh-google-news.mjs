#!/usr/bin/env node
/**
 * Standalone port of the general-news RSS fanout that /api/cron/daily
 * ran via `fanoutNews({ days: 14 })`. Fetches ~35 wire / analysis /
 * mining / defense / energy / central-bank feeds ONCE per run, then
 * distributes matched items to per-ticker shards where the entity's
 * displayName / aliases / cashtag appear in the headline.
 *
 * Design notes:
 *   - Single fetch, distribute across all events (vs the cron path
 *     which used to re-fetch inside the per-slice loop — the
 *     duplication that helped push slice 0 past the 300s ceiling).
 *   - Attaches to the SAME target logic as refresh-ir-rss: latest
 *     past event + next upcoming shell per ticker, gated to the
 *     [-2, +35] day window unless --only=<ticker> is passed.
 *   - 60-item ceiling per event's sources.items[] (shared with
 *     refresh-ir-rss so shards don't balloon).
 *
 *   node scripts/refresh-google-news.mjs           # write
 *   node scripts/refresh-google-news.mjs --dry-run
 *   node scripts/refresh-google-news.mjs --only=AAPL_US,HBM_US
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const AUDIT_PATH = path.join(ROOT, "scripts", "audits", "refresh-google-news.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONLY = (args.find((a) => a.startsWith("--only="))?.slice(7) ?? "")
  .split(",").map((t) => t.trim().replace(/_/g, " ")).filter(Boolean);
const ONLY_SET = ONLY.length ? new Set(ONLY) : null;

const UA = "Mozilla/5.0 EarningsDashboard/1.0 (+contact@example.com)";
const REQUEST_TIMEOUT_MS = 8_000;

// Mirror of frontend/server/vendors/news.ts RSS_SOURCES. Kept in
// sync manually — like the other .mjs ports.
const RSS_SOURCES = [
  { name: "Reuters", url: "https://news.google.com/rss/search?q=site:reuters.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "wire" },
  { name: "AP Business", url: "https://news.google.com/rss/search?q=site:apnews.com+business+when:7d&hl=en-US&gl=US&ceid=US:en", category: "wire" },
  { name: "FT Markets", url: "https://www.ft.com/markets?format=rss", category: "wire" },
  { name: "FT Companies", url: "https://www.ft.com/companies?format=rss", category: "wire" },
  { name: "FT World", url: "https://www.ft.com/world?format=rss", category: "wire" },
  { name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss", category: "wire" },
  { name: "Bloomberg Politics", url: "https://feeds.bloomberg.com/politics/news.rss", category: "wire" },
  { name: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", category: "wire" },
  { name: "WSJ World", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml", category: "wire" },
  { name: "MarketWatch Top", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", category: "wire" },
  { name: "Semafor", url: "https://news.google.com/rss/search?q=site:semafor.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "wire" },
  { name: "Economist Finance", url: "https://news.google.com/rss/search?q=site:economist.com+finance+when:7d&hl=en-US&gl=US&ceid=US:en", category: "analysis" },
  { name: "Economist Business", url: "https://news.google.com/rss/search?q=site:economist.com+business+when:7d&hl=en-US&gl=US&ceid=US:en", category: "analysis" },
  { name: "Northern Miner", url: "https://www.northernminer.com/feed/", category: "mining" },
  { name: "Canadian Mining Journal", url: "https://www.canadianminingjournal.com/feed/", category: "mining" },
  { name: "Mining.com", url: "https://news.google.com/rss/search?q=site:mining.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "mining" },
  { name: "Kitco", url: "https://news.google.com/rss/search?q=site:kitco.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "mining" },
  { name: "Defense News", url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml", category: "defense" },
  { name: "Breaking Defense", url: "https://breakingdefense.com/feed/", category: "defense" },
  { name: "Defense One", url: "https://www.defenseone.com/rss/all/", category: "defense" },
  { name: "World Nuclear News", url: "https://www.world-nuclear-news.org/rss", category: "energy" },
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", category: "energy" },
  { name: "Reuters Energy", url: "https://news.google.com/rss/search?q=site:reuters.com+energy+OR+oil+OR+gas+when:7d&hl=en-US&gl=US&ceid=US:en", category: "energy" },
  { name: "Nikkei Asia", url: "https://news.google.com/rss/search?q=site:asia.nikkei.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "asia" },
  { name: "SCMP", url: "https://www.scmp.com/rss/91/feed", category: "asia" },
  { name: "Politico EU", url: "https://www.politico.eu/feed/", category: "eu" },
  { name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", category: "central-bank" },
  { name: "ECB press", url: "https://www.ecb.europa.eu/rss/press.html", category: "central-bank" },
  { name: "BoE news", url: "https://www.bankofengland.co.uk/rss/news", category: "central-bank" },
];

const WINDOW_LEAD = 2;
const WINDOW_TRAIL = 35;
const NEWS_DAYS = 14;
const ITEM_LIMIT_PER_EVENT = 60;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function withinWindow(iso, today) {
  if (!iso) return false;
  const s = new Date(iso);
  const t = new Date(today);
  const start = new Date(s); start.setDate(start.getDate() - WINDOW_LEAD);
  const end = new Date(s); end.setDate(end.getDate() + WINDOW_TRAIL);
  return t >= start && t <= end;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function fetchRss(url) {
  try {
    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

function parseFeed(xml, source, category) {
  if (!xml) return [];
  const items = [];
  const rx = /<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/g;
  const matches = xml.match(rx) ?? [];
  for (const block of matches.slice(0, 15)) {
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
    let link = "";
    const atomLink = block.match(/<link\b[^>]*?href=["']([^"']+)["']/);
    if (atomLink) link = atomLink[1];
    else link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
    const dateRaw = (
      block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1] ??
      block.match(/<published[^>]*>([\s\S]*?)<\/published>/)?.[1] ??
      block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/)?.[1] ?? ""
    ).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    let time = null;
    if (dateRaw) {
      const t = new Date(dateRaw).getTime();
      if (!Number.isNaN(t)) time = new Date(t).toISOString();
    }
    if (!title || !link || link.startsWith("<")) continue;
    items.push({ headline: title, url: link, source, category, time });
  }
  return items;
}

function itemId(url, ticker) {
  const clean = String(url).replace(/[?#].*$/, "");
  const short = clean.slice(-24).replace(/[^A-Za-z0-9]/g, "");
  return `gn-${tickerSlug(ticker).slice(0, 4)}-${short}`.toLowerCase();
}

// Build the token set an entity uses for a headline substring test.
// Same idea as tickerSearchTokens on the server side: displayName +
// legalName + aliases + cashtag (with $ prefix), all lowercased.
function entityMatchTokens(entity) {
  const tokens = new Set();
  const add = (v) => { if (v && v.length >= 4) tokens.add(v.toLowerCase()); };
  add(entity.displayName);
  add(entity.legalName);
  for (const a of entity.aliases ?? []) add(a);
  if (entity.cashtag) tokens.add(("$" + entity.cashtag).toLowerCase());
  return tokens;
}

function mentionsEntity(headline, tokens) {
  const h = headline.toLowerCase();
  for (const t of tokens) if (h.includes(t)) return true;
  return false;
}

function pickTargetEvents(events, todayIso, ignoreWindow) {
  const past = events
    .filter((e) => e.eventDate)
    .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  const upcoming = events
    .filter((e) => !e.eventDate)
    .sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
  const out = [];
  if (past[0]) {
    const anchor = past[0].scheduledDate ?? past[0].eventDate;
    if (ignoreWindow || withinWindow(anchor, todayIso)) out.push(past[0]);
  }
  if (upcoming[0] && (ignoreWindow || withinWindow(upcoming[0].scheduledDate, todayIso))) {
    out.push(upcoming[0]);
  }
  return out;
}

function mergeItems(ev, newItems) {
  if (!ev.sources) ev.sources = { items: [], engineStatus: [] };
  if (!Array.isArray(ev.sources.items)) ev.sources.items = [];
  const existingUrls = new Set(ev.sources.items.map((i) => i.url));
  let appended = 0;
  for (const n of newItems) {
    if (existingUrls.has(n.url)) continue;
    ev.sources.items.push(n);
    existingUrls.add(n.url);
    appended++;
  }
  if (ev.sources.items.length > ITEM_LIMIT_PER_EVENT) {
    ev.sources.items.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
    ev.sources.items = ev.sources.items.slice(0, ITEM_LIMIT_PER_EVENT);
  }
  return appended;
}

async function main() {
  const todayIso = new Date().toISOString();
  const cutoff = Date.now() - NEWS_DAYS * 86_400_000;
  console.log(`refresh-google-news · dry=${DRY} · fetching ${RSS_SOURCES.length} feeds`);

  // Single fetch pass — parallelize by feed source (each is
  // independent, fails soft to []).
  const feedResults = await Promise.all(
    RSS_SOURCES.map(async (src) => {
      const xml = await fetchRss(src.url);
      const parsed = parseFeed(xml, src.name, src.category)
        .filter((i) => !i.time || new Date(i.time).getTime() >= cutoff);
      return { src, ok: !!xml, items: parsed };
    }),
  );
  const allItems = feedResults.flatMap((f) => f.items);
  const feedsOk = feedResults.filter((f) => f.ok).length;
  console.log(`  ${feedsOk}/${RSS_SOURCES.length} feeds succeeded, ${allItems.length} items in the pool`);

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter(
    (e) => e.securityType === "operating" && (!ONLY_SET || ONLY_SET.has(e.ticker)),
  );
  const ignoreWindow = ONLY_SET !== null;

  const rollup = {
    schema: "refresh-google-news/v1",
    generatedAt: todayIso,
    dry: DRY,
    feeds_ok: feedsOk,
    feeds_total: RSS_SOURCES.length,
    pool_items: allItems.length,
    entities_scanned: entities.length,
    tickers_updated: 0,
    items_appended: 0,
  };

  for (const entity of entities) {
    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let j;
    try { j = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { continue; }
    const wrapped = !Array.isArray(j);
    const events = wrapped ? j.events ?? [] : j;
    const targets = pickTargetEvents(events, todayIso, ignoreWindow);
    if (targets.length === 0) continue;
    const tokens = entityMatchTokens(entity);
    if (tokens.size === 0) continue;
    const matched = allItems
      .filter((i) => mentionsEntity(i.headline, tokens))
      .map((i) => ({
        id: itemId(i.url, entity.ticker),
        headline: i.headline,
        url: i.url,
        source: i.source,
        provenance: i.category === "central-bank" ? "regulatory" : "news",
        time: i.time,
        kind: "rss",
      }));
    if (matched.length === 0) continue;
    let appendedAny = 0;
    for (const ev of targets) appendedAny += mergeItems(ev, matched);
    if (appendedAny === 0) continue;
    rollup.tickers_updated++;
    rollup.items_appended += appendedAny;
    if (!DRY) {
      const body = wrapped ? { ...j, events } : events;
      await fs.writeFile(shardPath, JSON.stringify(body, null, 2));
    }
  }

  console.log(`\n=== refresh-google-news ===`);
  console.log(`  feeds ok:            ${rollup.feeds_ok}/${rollup.feeds_total}`);
  console.log(`  news pool:           ${rollup.pool_items} items`);
  console.log(`  entities scanned:    ${rollup.entities_scanned}`);
  console.log(`  tickers updated:     ${rollup.tickers_updated}`);
  console.log(`  items appended:      ${rollup.items_appended}`);
  await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await fs.writeFile(AUDIT_PATH, JSON.stringify(rollup, null, 2));
  console.log(`  audit → ${path.relative(ROOT, AUDIT_PATH)}`);
}

main().catch((e) => { console.error(`::error::refresh-google-news crash: ${e.stack ?? e.message}`); process.exit(1); });
