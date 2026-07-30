#!/usr/bin/env node
/**
 * The cadence-based detector over-flags STALE for fiscal-offset
 * issuers (AAPL, NVDA, WMT etc. whose quarterly cycle isn't a
 * clean 90-day gap). Before doing 40 hand-web-searches, pull
 * Yahoo's own calendarEvents.earnings module which returns the
 * canonical next-report-date per symbol. If that date is in the
 * future, the ticker isn't stale — reclassify.
 *
 * Cheap and mechanical (existing ingest pipe). Also updates the
 * upcoming shell's scheduledDate + precision so the watchlist
 * grid shows the right "next event" line instead of a stale
 * "X days ago".
 *
 *   node scripts/refine-stale-via-calendar.mjs [--dry]
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
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const STALENESS_PATH = path.join(OUT_DIR, `staleness-${TODAY_ISO}.json`);

const UA = "Mozilla/5.0 (refine-stale-via-calendar)";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const cs = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of cs) { const f = raw.split(";", 1)[0].trim(); const eq = f.indexOf("="); if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1)); }
  COOKIE = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: COOKIE } });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchCalendar(symbol) {
  if (!CRUMB || !COOKIE) return { error: "no-crumb" };
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: COOKIE }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const cal = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
    return { calendar: cal ?? null };
  } catch (e) { return { error: e.message ?? "network" }; }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`refine-stale-via-calendar · dry=${DRY}`);
  const audit = JSON.parse(await fs.readFile(STALENESS_PATH, "utf-8"));
  const stale = audit.perTicker.filter((t) => t.class === "STALE");
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);
  const targets = stale.filter((t) => byTicker.get(t.ticker)?.yahooSymbol);
  console.log(`STALE with yahooSymbol: ${targets.length} / ${stale.length}`);

  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }

  const rollup = {
    schema: "refine-stale-via-calendar/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      fetched: 0,
      fetchErrors: 0,
      noCalendar: 0,
      reclassifiedFutureExpected: 0,
      confirmedStale: 0,
      shardsUpdated: 0,
    },
    reclassified: [],
    confirmedStale: [],
  };
  const nowIso = new Date().toISOString();

  let processed = 0;
  await pool(targets, CONCURRENCY, async (t) => {
    processed++;
    const entity = byTicker.get(t.ticker);
    const r = await fetchCalendar(entity.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) { rollup.totals.fetchErrors++; return; }
    const cal = r.calendar;
    // Yahoo's earnings calendar returns earningsDate as an array of Unix
    // timestamps (usually one; sometimes a range like [approx, exact]).
    const earningsDates = (cal?.earningsDate ?? []).map((d) => d.raw ? new Date(d.raw * 1000) : null).filter(Boolean);
    if (earningsDates.length === 0) { rollup.totals.noCalendar++; return; }
    const nextDate = earningsDates[0];
    const nextIso = nextDate.toISOString().slice(0, 10);
    const isFuture = nextDate.getTime() > Date.now();

    if (isFuture) {
      // Not stale — Yahoo says report is expected on a future date.
      rollup.totals.reclassifiedFutureExpected++;
      rollup.reclassified.push({
        ticker: t.ticker,
        wasExpected: t.expectedDate,
        yahooExpected: nextIso,
        marketCapUsd: t.marketCapUsd,
      });
      // Update the upcoming shell's scheduledDate so the watchlist shows
      // the right "next event". If no upcoming shell exists, skip
      // (shard-earnings will build one on next rebuild).
      const shardPath = path.join(EVENTS_DIR, tickerSlug(t.ticker) + ".json");
      let shard;
      try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { return; }
      const wrapped = !Array.isArray(shard);
      const events = wrapped ? shard.events ?? [] : shard;
      const originalJson = JSON.stringify(events);
      const upcoming = events.find((e) => !e.eventDate);
      if (upcoming) {
        upcoming.scheduledDate = nextIso;
        upcoming.scheduledDateSource = "yahoo-calendarEvents";
        upcoming.provenanceAsOf = nowIso;
      }
      const nextJson = JSON.stringify(events);
      if (nextJson !== originalJson && !DRY) {
        const body = wrapped ? { ...shard, events } : events;
        fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
        rollup.totals.shardsUpdated++;
      }
    } else {
      // Yahoo says the reporting date is past. Confirmed stale (or Yahoo
      // hasn't refreshed the calendar to next quarter yet). Note it.
      rollup.totals.confirmedStale++;
      rollup.confirmedStale.push({
        ticker: t.ticker,
        yahooEarningsDate: nextIso,
        marketCapUsd: t.marketCapUsd,
        expectedPeriod: t.expectedPeriod,
      });
    }

    if (processed % 100 === 0) {
      console.log(`  ${processed}/${targets.length} · reclassified=${rollup.totals.reclassifiedFutureExpected} · confirmed=${rollup.totals.confirmedStale}`);
    }
  });

  console.log(`\n=== refine-stale-via-calendar ===`);
  console.log(`Fetched:                       ${rollup.totals.fetched}`);
  console.log(`Fetch errors:                  ${rollup.totals.fetchErrors}`);
  console.log(`No calendar returned:          ${rollup.totals.noCalendar}`);
  console.log(`Reclassified (future date):    ${rollup.totals.reclassifiedFutureExpected}`);
  console.log(`Confirmed stale (past date):   ${rollup.totals.confirmedStale}`);
  console.log(`Shards updated:                ${rollup.totals.shardsUpdated}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "refine-stale-via-calendar.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/refine-stale-via-calendar.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
