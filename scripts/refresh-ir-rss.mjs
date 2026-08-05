#!/usr/bin/env node
/**
 * Standalone IR + regulatory press-release fetch. Ports the sources-
 * fan-out portion of frontend/app/api/cron/daily/route.ts step 5c
 * that pulls per-ticker press releases into event.sources.items[].
 *
 * Sources per ticker (matching frontend/server/vendors/pressReleases.ts):
 *   1. Auto-CIK EDGAR atom feed — synthesized from entity.edgarCik.
 *      Covers every SEC filer (US-listed + 20-F/40-F foreign) with no
 *      hand-mapping.
 *   2. Hand-curated OFFICIAL_SOURCES — IR-page RSS/Atom URLs for
 *      names where the IR feed carries useful non-filing content
 *      (Apple newsroom, mining operational updates, etc.) OR where
 *      auto-CIK returns nothing (Canadian-only listings).
 *
 * Gating: only fetches for tickers with an event whose scheduledDate
 * (upcoming shell OR the latest past event) falls in the [-2, +35]
 * day window vs today — same rule as the cron. Outside this window,
 * press releases are noise; the upcoming SEC filing / IR announcement
 * is either far away or long past.
 *
 * Idempotency: existing sources.items are keyed by URL. New items
 * append with a stable id derived from url + provenance. Fires on
 * the LATEST past event (post-report press-release trickle) AND the
 * next upcoming shell (pre-report announcements).
 *
 * CLI:
 *   node scripts/refresh-ir-rss.mjs               # write
 *   node scripts/refresh-ir-rss.mjs --dry-run     # report only
 *   node scripts/refresh-ir-rss.mjs --only=AAPL_US,SHLE_CN
 *
 * Rate-limits: SEC 1 req/s enforced. IR-page fetches ≤8s timeout,
 * concurrency 6.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONLY = (args.find((a) => a.startsWith("--only="))?.slice(7) ?? "")
  .split(",").map((t) => t.trim().replace(/_/g, " ")).filter(Boolean);
const ONLY_SET = ONLY.length ? new Set(ONLY) : null;

const WINDOW_LEAD = 2;
const WINDOW_TRAIL = 35;
const REQUEST_TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;
// SEC EDGAR fair-access — real contact email required.
const SEC_UA = `earnings-dashboard ${process.env.EDGAR_CONTACT_EMAIL || "klpp@bluorbank.lv"}`;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// Mirror of frontend/server/vendors/pressReleases.ts OFFICIAL_SOURCES.
// Kept in sync manually (like other .mjs mirrors of TS logic).
const OFFICIAL_SOURCES = {
  "CENX US": [{ kind: "rss", url: "https://centuryaluminum.com/feed/", provenance: "ir-page", label: "Century Aluminum IR" }],
  "HBM US": [{ kind: "rss", url: "https://hudbayminerals.com/rss/PressRelease.aspx", provenance: "ir-page", label: "Hudbay IR" }],
  "CS CN": [{ kind: "rss", url: "https://capstonecopper.com/feed/", provenance: "ir-page", label: "Capstone Copper IR" }],
  "SCMI CN": [{ kind: "rss", url: "https://feeds.newsfilecorp.com/company/11605", provenance: "wire", label: "Newsfile" }],
  "TOI CN": [{ kind: "rss", url: "https://topicus.com/rss", provenance: "ir-page", label: "Topicus IR" }],
  "DBG CN": [{ kind: "rss", url: "https://www.doubleview.ca/feed/", provenance: "ir-page", label: "Doubleview Gold IR" }],
  "VLE CN": [{ kind: "rss", url: "https://www.valeuraenergy.com/feed/", provenance: "ir-page", label: "Valeura Energy IR" }],
  "AAPL US": [{ kind: "rss", url: "https://www.apple.com/newsroom/rss-feed.rss", provenance: "ir-page", label: "Apple Newsroom" }],
};

const EDGAR_URL = (cik) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40&output=atom`;

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

function withinWindow(scheduledIso, todayIso) {
  if (!scheduledIso) return false;
  const s = new Date(scheduledIso);
  const t = new Date(todayIso);
  const start = new Date(s); start.setDate(start.getDate() - WINDOW_LEAD);
  const end = new Date(s); end.setDate(end.getDate() + WINDOW_TRAIL);
  return t >= start && t <= end;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// SEC courtesy: single-thread + 1 req/s. Feeds request through a queue.
let secLastFetchAt = 0;
async function fetchEdgar(url) {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - secLastFetchAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  secLastFetchAt = Date.now();
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": SEC_UA,
        Accept: "application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function fetchRss(url) {
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Minimal RSS + Atom parser — good enough for entry title/link/pubDate.
// Handles both <item> (RSS) and <entry> (Atom). Extracts href from <link>
// (Atom) via attribute regex, or the tag text (RSS).
function parseFeed(xml) {
  if (!xml || typeof xml !== "string") return [];
  const items = [];
  const isAtom = /<feed[\s>][\s\S]*?<entry\b/.test(xml);
  const tag = isAtom ? "entry" : "item";
  const rx = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "g");
  const matches = xml.match(rx) ?? [];
  for (const m of matches) {
    // Title — RSS + Atom both use <title>
    const title = (m.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
    // Link — Atom uses <link href="..."/>; RSS uses <link>URL</link>
    let link = "";
    if (isAtom) {
      // Prefer rel="alternate" when multiple links exist.
      const alt = m.match(/<link\b[^>]*?rel=["']alternate["'][^>]*?href=["']([^"']+)["']/);
      if (alt) link = alt[1];
      else link = m.match(/<link\b[^>]*?href=["']([^"']+)["']/)?.[1] ?? "";
    } else {
      link = (m.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
    }
    // Date — RSS uses <pubDate>, Atom uses <published> or <updated>
    const dateRaw = (
      m.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1] ??
      m.match(/<published[^>]*>([\s\S]*?)<\/published>/)?.[1] ??
      m.match(/<updated[^>]*>([\s\S]*?)<\/updated>/)?.[1] ?? ""
    ).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    let iso = null;
    if (dateRaw && dateRaw.trim()) {
      const t = new Date(dateRaw.trim()).getTime();
      if (!Number.isNaN(t)) iso = new Date(t).toISOString();
    }
    if (!title || !link) continue;
    items.push({ title, link, time: iso });
  }
  return items;
}

// Stable id for a source item — url is the natural key.
function itemId(url, ticker) {
  // Simple hash: last 24 chars of url + first 4 of slug. Same URL → same id.
  const clean = String(url).replace(/[?#].*$/, "");
  const short = clean.slice(-24).replace(/[^A-Za-z0-9]/g, "");
  return `pr-${tickerSlug(ticker).slice(0, 4)}-${short}`.toLowerCase();
}

async function fetchAllForTicker(entity, todayIso) {
  const feeds = [];
  const official = OFFICIAL_SOURCES[entity.ticker] ?? [];
  for (const s of official) feeds.push({ ...s, source: "official" });
  if (entity.edgarCik) {
    feeds.push({
      kind: "edgar",
      url: EDGAR_URL(entity.edgarCik),
      provenance: "regulatory",
      label: "SEC EDGAR filings",
      source: "edgar-auto",
    });
  }
  const status = [];
  const items = [];
  for (const f of feeds) {
    const xml = f.kind === "edgar" ? await fetchEdgar(f.url) : await fetchRss(f.url);
    const parsed = parseFeed(xml);
    status.push({ label: f.label, kind: f.kind, ok: !!xml, itemsFound: parsed.length });
    for (const p of parsed) {
      items.push({
        id: itemId(p.link, entity.ticker),
        headline: p.title,
        url: p.link,
        source: f.label,
        provenance: f.provenance,
        time: p.time,
        kind: f.kind,
      });
    }
  }
  return { items, status };
}

async function loadShard(ticker) {
  const p = path.join(EVENTS_DIR, tickerSlug(ticker) + ".json");
  try {
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    return { path: p, wrapped: !Array.isArray(j), body: j };
  } catch {
    return null;
  }
}

function pickTargetEvents(events, todayIso, ignoreWindow = false) {
  const past = events
    .filter((e) => e.eventDate)
    .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  const upcoming = events
    .filter((e) => !e.eventDate)
    .sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
  const targets = [];
  if (past[0]) {
    const anchor = past[0].scheduledDate ?? past[0].eventDate;
    if (ignoreWindow || withinWindow(anchor, todayIso)) targets.push(past[0]);
  }
  if (upcoming[0] && (ignoreWindow || withinWindow(upcoming[0].scheduledDate, todayIso))) {
    targets.push(upcoming[0]);
  }
  return targets;
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
  // Trim to a reasonable ceiling (60 items) so shards don't balloon
  // on tickers with many long-running press-release feeds.
  if (ev.sources.items.length > 60) {
    ev.sources.items.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
    ev.sources.items = ev.sources.items.slice(0, 60);
  }
  return appended;
}

async function processTicker(entity, todayIso, rollup, ignoreWindow) {
  const shard = await loadShard(entity.ticker);
  if (!shard) return;
  const events = shard.wrapped ? shard.body.events : shard.body;
  const targets = pickTargetEvents(events, todayIso, ignoreWindow);
  if (targets.length === 0) return;

  const { items, status } = await fetchAllForTicker(entity, todayIso);
  rollup.ticker_status[entity.ticker] = status;
  if (items.length === 0) return;

  let appendedAny = 0;
  for (const ev of targets) {
    appendedAny += mergeItems(ev, items);
  }
  if (appendedAny === 0) return;
  rollup.tickers_updated++;
  rollup.items_appended += appendedAny;

  if (!DRY) {
    const out = shard.wrapped ? { ...shard.body, events } : events;
    await fs.writeFile(shard.path, JSON.stringify(out, null, 2));
  }
  rollup.updates.push({ ticker: entity.ticker, appended: appendedAny, feeds: status.length });
}

async function runPool(items, worker, concurrency) {
  const q = items.slice();
  const workers = Array.from({ length: concurrency }, async () => {
    while (q.length > 0) {
      const item = q.shift();
      if (!item) break;
      try { await worker(item); } catch { /* fail-soft per ticker */ }
    }
  });
  await Promise.all(workers);
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter(
    (e) => e.securityType === "operating" && (!ONLY_SET || ONLY_SET.has(e.ticker)),
  );
  const todayIso = new Date().toISOString();
  const rollup = {
    schema: "refresh-ir-rss/v1",
    generatedAt: todayIso,
    dry: DRY,
    entities_scanned: entities.length,
    tickers_updated: 0,
    items_appended: 0,
    updates: [],
    ticker_status: {},
  };
  console.log(`refresh-ir-rss · dry=${DRY} · scanning ${entities.length} entities`);

  // When a user explicitly names tickers via --only, ignore the
  // scheduled-window gate — they're asking for the fetch now, not
  // "if it happens to be in the announcement window today". Universe
  // runs (no --only) keep the gate to avoid pointless fetches.
  const ignoreWindow = ONLY_SET !== null;
  if (ignoreWindow) console.log(`  --only= supplied · ignoring [-${WINDOW_LEAD},+${WINDOW_TRAIL}]d window gate`);

  await runPool(entities, (e) => processTicker(e, todayIso, rollup, ignoreWindow), CONCURRENCY);

  console.log(`\n=== refresh-ir-rss ===`);
  console.log(`  entities scanned:  ${rollup.entities_scanned}`);
  console.log(`  tickers updated:   ${rollup.tickers_updated}`);
  console.log(`  items appended:    ${rollup.items_appended}`);
  for (const u of rollup.updates.slice(0, 15)) {
    console.log(`    ${u.ticker.padEnd(14)} +${u.appended} items from ${u.feeds} feed(s)`);
  }
  if (rollup.updates.length > 15) console.log(`    …+${rollup.updates.length - 15} more`);

  const auditPath = path.join(ROOT, "scripts", "audits", "refresh-ir-rss.json");
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.writeFile(auditPath, JSON.stringify(rollup, null, 2));
}

main().catch((e) => {
  console.error(`::error::refresh-ir-rss crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
