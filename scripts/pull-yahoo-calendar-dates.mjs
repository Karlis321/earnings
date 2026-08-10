#!/usr/bin/env node
/**
 * For every entity with an upcoming shell + yahooSymbol, fetch
 * Yahoo's calendarEvents.earnings.earningsDate and overwrite
 * scheduledDate with the actual company-published date (when Yahoo
 * has one). Stamps scheduledDateSource = "yahoo-calendarEvents".
 *
 * Unlike refine-stale-via-calendar.mjs which only touches tickers
 * pre-classified as STALE by the cadence detector, this pulls Yahoo
 * for EVERY upcoming shell so the site never shows estimator-projected
 * dates when a real one is available. Estimator projections stay as
 * a fallback for tickers Yahoo doesn't cover (foreign ADRs, small caps).
 *
 * Guardrails:
 *   - Never overwrites a shell whose scheduledDateSource is
 *     "company-disclosed*" (manual verification always wins).
 *   - Only overwrites if Yahoo's date is in the future OR within the
 *     last 5 days (recent past = event just reported, mature-* should
 *     have caught it; leave stale for next cron).
 *   - Concurrency 4 with 1s spacing between requests. At ~3000 targets
 *     that's ~13 minutes worst case.
 *
 *   node scripts/pull-yahoo-calendar-dates.mjs [--dry] [--limit=N]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
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

const UA = "Mozilla/5.0 (pull-yahoo-calendar-dates)";
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 15_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  try {
    const cachePath = path.join(os.tmpdir(), "yahoo-crumb.json");
    const raw = await fs.readFile(cachePath, "utf-8");
    const j = JSON.parse(raw);
    if (j.crumb && j.cookie) { CRUMB = j.crumb; COOKIE = j.cookie; return; }
  } catch { /* no cache */ }
  // Prime from scratch — hit any Yahoo page to seed cookies + crumb.
  const seedR = await fetch("https://finance.yahoo.com/quote/AAPL/", {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const setCookie = seedR.headers.getSetCookie?.() ?? [];
  COOKIE = setCookie.map((c) => c.split(";")[0]).join("; ");
  const crumbR = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  CRUMB = (await crumbR.text()).trim();
}

async function fetchEarningsDate(symbol) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const cal = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
    const dates = (cal?.earningsDate ?? []).map((d) => (d.raw ? new Date(d.raw * 1000) : null)).filter(Boolean);
    if (dates.length === 0) return { noCalendar: true };
    return { date: dates[0], quality: cal?.earningsCallTimeType ?? null };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`pull-yahoo-calendar-dates · dry=${DRY} · limit=${LIMIT === Infinity ? "all" : LIMIT}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  // Build the list of tickers with upcoming shells that we should refine.
  const targets = [];
  const shardFiles = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  for (const f of shardFiles) {
    const shardPath = path.join(EVENTS_DIR, f);
    const shard = JSON.parse(await fs.readFile(shardPath, "utf-8"));
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? (shard.events ?? []) : shard;
    // Find upcoming shells (no eventDate, has scheduledDate).
    const upcoming = events.filter((e) => !e.eventDate && e.scheduledDate);
    if (upcoming.length === 0) continue;
    // Take the nearest-future upcoming shell for this ticker.
    upcoming.sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || ""));
    const shell = upcoming[0];
    // Skip if source is company-disclosed (manual verification wins).
    if (shell.scheduledDateSource?.startsWith("company-disclosed")) continue;
    const entity = byTicker.get(shell.ticker);
    if (!entity?.yahooSymbol) continue;
    // Only consider operating entities.
    if (entity.securityType !== "operating") continue;
    targets.push({ ticker: shell.ticker, yahooSymbol: entity.yahooSymbol, shardPath, wrapped, shard, events, shell });
  }
  console.log(`upcoming shells with yahooSymbol: ${targets.length}`);

  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }

  const rollup = {
    schema: "pull-yahoo-calendar-dates/v1",
    generatedAt: new Date().toISOString(),
    totals: { fetched: 0, fetchErrors: 0, noCalendar: 0, updated: 0, unchanged: 0, pastSkipped: 0 },
    updates: [],
  };
  const nowMs = Date.now();
  const shardsToWrite = new Map();

  let processed = 0;
  await pool(targets.slice(0, Math.min(LIMIT, targets.length)), CONCURRENCY, async (t) => {
    processed++;
    if (processed % 100 === 0) console.log(`  ${processed}/${Math.min(LIMIT, targets.length)}`);
    const r = await fetchEarningsDate(t.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) { rollup.totals.fetchErrors++; return; }
    if (r.noCalendar) { rollup.totals.noCalendar++; return; }
    const yahooDateIso = r.date.toISOString().slice(0, 10);
    if (yahooDateIso === t.shell.scheduledDate) {
      rollup.totals.unchanged++;
      return;
    }
    // Only update if Yahoo's date is in the future or within last 5 days.
    if (r.date.getTime() < nowMs - 5 * 86_400_000) {
      rollup.totals.pastSkipped++;
      return;
    }
    const old = t.shell.scheduledDate;
    t.shell.scheduledDate = yahooDateIso;
    t.shell.scheduledDateSource = "yahoo-calendarEvents";
    t.shell.provenance = "yahoo-calendar";
    t.shell.provenanceAsOf = new Date().toISOString();
    shardsToWrite.set(t.shardPath, { wrapped: t.wrapped, shard: t.shard, events: t.events });
    rollup.totals.updated++;
    rollup.updates.push({ ticker: t.ticker, from: old, to: yahooDateIso });
  });

  if (!DRY) {
    for (const [p, { wrapped, shard, events }] of shardsToWrite) {
      const body = wrapped ? { ...shard, events } : events;
      await fs.writeFile(p, JSON.stringify(body, null, 0));
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "pull-yahoo-calendar-dates.json"), JSON.stringify(rollup, null, 2));

  console.log(`\n=== pull-yahoo-calendar-dates ===`);
  console.log(`  fetched:        ${rollup.totals.fetched}`);
  console.log(`  fetch errors:   ${rollup.totals.fetchErrors}`);
  console.log(`  no calendar:    ${rollup.totals.noCalendar}`);
  console.log(`  unchanged:      ${rollup.totals.unchanged}`);
  console.log(`  past skipped:   ${rollup.totals.pastSkipped}`);
  console.log(`  UPDATED:        ${rollup.totals.updated}`);
  console.log(`  shards written: ${DRY ? "(dry-run)" : shardsToWrite.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
