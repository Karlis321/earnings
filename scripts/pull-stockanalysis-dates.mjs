#!/usr/bin/env node
/**
 * Fallback earnings-date source: stockanalysis.com. For every ticker
 * that still has an estimator-projected scheduledDate (i.e. Yahoo
 * didn't provide a calendar date), try to pull a real date from
 * stockanalysis.com's per-ticker statistics page. That page shows
 * "Earnings Date: <Month DD, YYYY>" for US-listed and OTC-listed
 * securities including foreign ADRs like BOLSY.
 *
 * URL patterns:
 *   - stockanalysis.com/stocks/<SYMBOL>/statistics/  (NYSE / NASDAQ)
 *   - stockanalysis.com/quote/otc/<SYMBOL>/           (OTC pink sheets)
 *
 * Guardrails:
 *   - Never overwrites shells whose scheduledDateSource is
 *     company-disclosed* or yahoo-calendarEvents (both are more
 *     authoritative than a scraper).
 *   - Only overwrites if the parsed date is future or within last 5
 *     days.
 *   - Concurrency 3, ~1s spacing between requests. ~3s per ticker.
 *
 *   node scripts/pull-stockanalysis-dates.mjs [--dry] [--limit=N]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0) || Infinity;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 15_000;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseEarningsDate(html) {
  // Look for "Earnings Date" label followed by a date value.
  // Format: <span>Earnings Date</span>...<span>Aug 11, 2026</span>
  // or JSON-like data blobs. Match any "Earnings Date" occurrence + nearest date.
  const idx = html.search(/Earnings Date/i);
  if (idx < 0) return null;
  // Look in the next 500 chars for a date pattern.
  const window = html.slice(idx, idx + 500);
  const m = window.match(/([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(20\d{2})/);
  if (!m) return null;
  const monthIdx = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (monthIdx === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, monthIdx, day));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function fetchDate(ticker, symbol, isForeignAdr) {
  // Try /stocks/<sym>/statistics/ first, then /quote/otc/<sym>/.
  const urls = isForeignAdr
    ? [`https://stockanalysis.com/quote/otc/${symbol}/`]
    : [
        `https://stockanalysis.com/stocks/${symbol.toLowerCase()}/statistics/`,
        `https://stockanalysis.com/stocks/${symbol.toLowerCase()}/`,
        `https://stockanalysis.com/quote/otc/${symbol}/`,
      ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "follow",
      });
      if (r.status === 404) continue;
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const html = await r.text();
      const d = parseEarningsDate(html);
      if (d) return { date: d, url };
    } catch (e) {
      // network / timeout — try next url
      continue;
    }
  }
  return { noDate: true };
}

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; await fn(items[idx], idx); await new Promise((r) => setTimeout(r, 300)); }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`pull-stockanalysis-dates · dry=${DRY} · limit=${LIMIT === Infinity ? "all" : LIMIT}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  // Targets: shells where scheduledDateSource looks like an estimator
  // (not yahoo-calendarEvents and not company-disclosed).
  const targets = [];
  const shardFiles = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  for (const f of shardFiles) {
    const shardPath = path.join(EVENTS_DIR, f);
    const shard = JSON.parse(await fs.readFile(shardPath, "utf-8"));
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? (shard.events ?? []) : shard;
    const upcoming = events.filter((e) => !e.eventDate && e.scheduledDate);
    if (upcoming.length === 0) continue;
    upcoming.sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || ""));
    const shell = upcoming[0];
    const src = shell.scheduledDateSource || "";
    // Skip company-disclosed and Yahoo (both better sources).
    if (src.startsWith("company-disclosed") || src === "yahoo-calendarEvents") continue;
    const entity = byTicker.get(shell.ticker);
    if (!entity) continue;
    if (entity.securityType !== "operating") continue;
    // Parse Bloomberg ticker "AAPL US" → symbol=AAPL, country=US.
    const parts = shell.ticker.split(/\s+/);
    if (parts.length < 2) continue;
    const symbol = parts[0];
    const country = parts[1];
    // US-listed OR US-domiciled ADRs (foreign ticker with US suffix).
    // Skip foreign non-US listings (KS, JP, LN, IN, etc.) — stockanalysis
    // doesn't cover those. They stay on estimator.
    if (country !== "US") continue;
    // OTC detection: no CIK typically means pink-sheet/ADR.
    const isForeignAdr = !entity.edgarCik;
    targets.push({ ticker: shell.ticker, symbol, isForeignAdr, shardPath, wrapped, shard, events, shell });
  }
  console.log(`estimator-based US-listed shells: ${targets.length}`);

  const rollup = {
    schema: "pull-stockanalysis-dates/v1",
    generatedAt: new Date().toISOString(),
    totals: { fetched: 0, fetchErrors: 0, noDate: 0, updated: 0, unchanged: 0, pastSkipped: 0 },
    updates: [],
  };
  const nowMs = Date.now();
  const shardsToWrite = new Map();

  let processed = 0;
  await pool(targets.slice(0, Math.min(LIMIT, targets.length)), CONCURRENCY, async (t) => {
    processed++;
    if (processed % 50 === 0) console.log(`  ${processed}/${Math.min(LIMIT, targets.length)}`);
    const r = await fetchDate(t.ticker, t.symbol, t.isForeignAdr);
    rollup.totals.fetched++;
    if (r.error) { rollup.totals.fetchErrors++; return; }
    if (r.noDate) { rollup.totals.noDate++; return; }
    const iso = r.date.toISOString().slice(0, 10);
    if (iso === t.shell.scheduledDate) { rollup.totals.unchanged++; return; }
    if (r.date.getTime() < nowMs - 5 * 86_400_000) { rollup.totals.pastSkipped++; return; }
    const old = t.shell.scheduledDate;
    t.shell.scheduledDate = iso;
    t.shell.scheduledDateSource = "stockanalysis.com";
    t.shell.provenance = "stockanalysis-com";
    t.shell.provenanceAsOf = new Date().toISOString();
    shardsToWrite.set(t.shardPath, { wrapped: t.wrapped, shard: t.shard, events: t.events });
    rollup.totals.updated++;
    rollup.updates.push({ ticker: t.ticker, from: old, to: iso });
  });

  if (!DRY) {
    for (const [p, { wrapped, shard, events }] of shardsToWrite) {
      const body = wrapped ? { ...shard, events } : events;
      await fs.writeFile(p, JSON.stringify(body, null, 0));
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "pull-stockanalysis-dates.json"), JSON.stringify(rollup, null, 2));

  console.log(`\n=== pull-stockanalysis-dates ===`);
  console.log(`  fetched:        ${rollup.totals.fetched}`);
  console.log(`  fetch errors:   ${rollup.totals.fetchErrors}`);
  console.log(`  no date:        ${rollup.totals.noDate}`);
  console.log(`  unchanged:      ${rollup.totals.unchanged}`);
  console.log(`  past skipped:   ${rollup.totals.pastSkipped}`);
  console.log(`  UPDATED:        ${rollup.totals.updated}`);
  console.log(`  shards written: ${DRY ? "(dry-run)" : shardsToWrite.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
