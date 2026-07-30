#!/usr/bin/env node
/**
 * One-shot repair for shell-placeholder eventDates on past events.
 *
 * Root cause (item 2 of prompt 4fb41ee): when the yahoo-timeseries
 * hydration step merges metric values into an existing shell event
 * (created by the shell-seeder with a mid-month-15th placeholder),
 * it enriches `metrics` and `provenance_merged` but never refreshes
 * `eventDate`. Result: 1,765 past events read a fake precision date.
 *
 * This script does a one-time pass over every past event whose
 * eventDate ends `-15`. For each, it looks for a better source:
 *
 *   1. Yahoo fundamentals-timeseries `asOfDate` — the actual
 *      quarter-end for the matching FY/Q. Batched per ticker.
 *   2. SEC submissions `filingDate` — for CIK-bearing entities,
 *      the exact filed date of the periodic (10-Q/K, 20-F, 40-F,
 *      6-K) covering that period.
 *
 * Precedence: SEC filing date wins when present (it's the actual
 * filed date, precise to the day). Yahoo asOfDate is the fallback
 * (precise to quarter-end, not filing date, but far more accurate
 * than the 15th placeholder). If neither is available, the
 * placeholder is preserved AND an `eventDateEstimated: true` flag
 * is stamped so the UI's est-marker heuristic keeps working.
 *
 *   node scripts/repair-shell-eventdates.mjs           # write
 *   node scripts/repair-shell-eventdates.mjs --dry     # report only
 *   node scripts/repair-shell-eventdates.mjs --resume  # skip files where
 *                                                       all 15th events
 *                                                       already have an
 *                                                       eventDateSource
 *                                                       marker
 *
 * Never mutates non-15th eventDates. Never fabricates a date if no
 * external source has one. Report: corrected / kept-as-estimate,
 * split by source.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const RESUME = process.argv.includes("--resume");

const UA = "Mozilla/5.0 (repair-shell-eventdates)";
const SEC_UA = "Earnings Tracker (klpp@bluorbank.lv)";
// Parallel worker pool over Yahoo. SEC calls stay serial via a shared
// limiter (SEC's fair-access cap applies across all workers, not per-
// worker). Concurrency=4 gets us ~5-6 min end-to-end vs the 20+ min
// stall the serial version hit on Yahoo-timeseries timeouts.
const YAHOO_CONCURRENCY = 4;
const YAHOO_TIMEOUT_MS = 8000;
const SEC_TIMEOUT_MS = 12000;
const SEC_MS = 1100; // shared limiter across workers
const CRUMB_REPRIME_EVERY = 100; // re-prime crumb every N Yahoo calls

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function is15th(iso) { return typeof iso === "string" && /^\d{4}-\d{2}-15$/.test(iso); }
function periodKey(y, q) { return `FY${y} Q${q}`; }
function periodFromEnd(iso) {
  const d = new Date(iso);
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 };
}

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const setCookies = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of setCookies) {
    const f = raw.split(";", 1)[0].trim();
    const eq = f.indexOf("=");
    if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
  }
  COOKIE = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE },
  });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

// Yahoo fundamentals-timeseries returns per-quarter asOfDate for each
// metric type; we grab quarterlyTotalRevenue as a marker because
// every operating company reports revenue. Returns Map<periodKey, asOfDate>.
let YAHOO_CALLS = 0;
async function yahooAsOfDates(symbol) {
  // Periodic crumb refresh — Yahoo cookies expire after ~10 min of
  // activity and 401s start rolling in. Re-priming every 100 calls
  // avoids the mid-run stall.
  if (YAHOO_CALLS > 0 && YAHOO_CALLS % CRUMB_REPRIME_EVERY === 0) {
    await primeCrumb();
  }
  YAHOO_CALLS++;
  const now = Math.floor(Date.now() / 1000);
  const from = now - 8 * 365 * 24 * 3600;
  const url =
    `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?type=quarterlyTotalRevenue&period1=${from}&period2=${now}&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const series = j?.timeseries?.result ?? [];
    const out = new Map();
    for (const r of series) {
      const dataKey = Object.keys(r).find((k) => k !== "meta" && k !== "timestamp");
      if (!dataKey) continue;
      const data = r[dataKey] ?? [];
      for (const d of data) {
        if (!d?.asOfDate) continue;
        if (d.periodType && d.periodType !== "3M") continue;
        const { year, quarter } = periodFromEnd(d.asOfDate);
        out.set(periodKey(year, quarter), d.asOfDate);
      }
    }
    return out;
  } catch {
    return null;
  }
}

// SEC submissions: /submissions/CIK{padded}.json. Returns Map<periodKey,
// filingDate> for periodic forms only. Uses form + reportDate — the
// filingDate is the actual accepted-at-EDGAR date, the reportDate is
// the period end. Match on reportDate's quarter for the period key.
// Shared SEC rate limiter — 10 req/s cap but I stay at ~0.9 req/s (1100ms).
let secNextSlot = 0;
async function secLimit() {
  const now = Date.now();
  const t = Math.max(now, secNextSlot);
  secNextSlot = t + SEC_MS;
  if (t > now) await new Promise((r) => setTimeout(r, t - now));
}

async function secFilingDates(cik) {
  await secLimit();
  const padded = String(cik).padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(SEC_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const recent = j?.filings?.recent;
    if (!recent) return null;
    const forms = recent.form ?? [];
    const filingDates = recent.filingDate ?? [];
    const reportDates = recent.reportDate ?? [];
    const out = new Map();
    const periodic = new Set(["10-Q", "10-Q/A", "10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A", "6-K"]);
    for (let i = 0; i < forms.length; i++) {
      if (!periodic.has(forms[i])) continue;
      const rep = reportDates[i];
      const filed = filingDates[i];
      if (!rep || !filed) continue;
      const { year, quarter } = periodFromEnd(rep);
      const k = periodKey(year, quarter);
      // Prefer the earliest filing per period (amendments come later
      // and re-report the same period).
      if (!out.has(k)) out.set(k, filed);
    }
    return out;
  } catch {
    return null;
  }
}

async function readShard(fp) {
  const j = JSON.parse(await fs.readFile(fp, "utf-8"));
  return { wrapped: !Array.isArray(j), body: j, events: Array.isArray(j) ? j : (j.events ?? []) };
}
async function writeShard(fp, ctx) {
  const body = ctx.wrapped ? { ...ctx.body, events: ctx.events } : ctx.events;
  await fs.writeFile(fp, JSON.stringify(body, null, 2));
}

async function main() {
  console.log(`repair-shell-eventdates · dry=${DRY} resume=${RESUME}`);
  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entityByTicker = new Map((reg.entities ?? []).map((e) => [e.ticker, e]));

  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  // Pass 1: scan shards to enumerate 15th-dated events by ticker.
  const targetsByTicker = new Map();
  let scanned15 = 0;
  for (const f of files) {
    const ctx = await readShard(path.join(EVENTS_DIR, f));
    const hits = [];
    for (const ev of ctx.events) {
      if (!is15th(ev.eventDate)) continue;
      if (RESUME && ev.eventDateSource) continue;
      hits.push(ev);
    }
    if (hits.length === 0) continue;
    const ticker = ctx.events[0]?.ticker ?? f.replace(/\.json$/, "").replace(/_/g, " ");
    targetsByTicker.set(ticker, { shard: path.join(EVENTS_DIR, f), ctx, hits });
    scanned15 += hits.length;
  }
  console.log(`Tickers with 15th-dated events: ${targetsByTicker.size}`);
  console.log(`Total 15th-dated past events:   ${scanned15}`);

  // Pass 2: worker pool. Yahoo goes concurrent; SEC is limited via the
  // shared secLimit() slot allocator so bursts across workers don't
  // exceed the fair-access cap. Checkpoint the audit's per-ticker
  // entries + tickersDone set every 25 finished tickers so an
  // interruption resumes on the next run.
  const CKPT_PATH = path.join(OUT_DIR, "shell-eventdates-repair.checkpoint.json");
  await fs.mkdir(OUT_DIR, { recursive: true });
  const ckpt = await (async () => {
    try { return JSON.parse(await fs.readFile(CKPT_PATH, "utf-8")); }
    catch { return null; }
  })();
  const done = new Set(ckpt?.done ?? []);
  const audit = {
    schema: "shell-eventdates-repair/v1",
    generatedAt: new Date().toISOString(),
    scanned15,
    correctedFromSec: ckpt?.correctedFromSec ?? 0,
    correctedFromYahoo: ckpt?.correctedFromYahoo ?? 0,
    keptAsEstimate: ckpt?.keptAsEstimate ?? 0,
    perTicker: ckpt?.perTicker ?? [],
  };
  const allTickers = [...targetsByTicker.keys()];
  const tickers = allTickers.filter((t) => !done.has(t));
  console.log(`Tickers remaining (post-checkpoint): ${tickers.length} / ${allTickers.length}`);

  const shardsToWrite = new Set();
  const nowIso = new Date().toISOString();
  let processed = 0;

  const processTicker = async (ticker) => {
    const ent = entityByTicker.get(ticker);
    const yahooSym = ent?.yahooSymbol ?? null;
    const cik = ent?.edgarCik ?? null;
    const target = targetsByTicker.get(ticker);
    const [yahooMap, secMap] = await Promise.all([
      yahooSym ? yahooAsOfDates(yahooSym) : null,
      cik ? secFilingDates(cik) : null,
    ]);
    const per = { ticker, yahoo: yahooSym, cik, corrected: [], keptEstimate: [] };
    for (const ev of target.hits) {
      const period = ev.period ?? null;
      if (!period) { per.keptEstimate.push({ period, reason: "no-period-label" }); continue; }
      const secDate = secMap?.get(period);
      if (secDate) {
        ev.eventDate = secDate;
        ev.eventDateSource = "sec-submissions-filingDate";
        ev.eventDateCorrectedAt = nowIso;
        audit.correctedFromSec++;
        per.corrected.push({ period, newDate: secDate, source: "sec-submissions" });
        shardsToWrite.add(target.shard);
        continue;
      }
      const yahooDate = yahooMap?.get(period);
      if (yahooDate) {
        ev.eventDate = yahooDate;
        ev.eventDateSource = "yahoo-timeseries-asOfDate";
        ev.eventDateCorrectedAt = nowIso;
        audit.correctedFromYahoo++;
        per.corrected.push({ period, newDate: yahooDate, source: "yahoo-timeseries" });
        shardsToWrite.add(target.shard);
        continue;
      }
      ev.eventDateEstimated = true;
      audit.keptAsEstimate++;
      per.keptEstimate.push({ period, reason: "no-external-date-source" });
      shardsToWrite.add(target.shard);
    }
    audit.perTicker.push(per);
    done.add(ticker);
    processed++;
    if (processed % 25 === 0 || processed === tickers.length) {
      console.log(
        `  ${processed}/${tickers.length} tickers · sec=${audit.correctedFromSec} · yahoo=${audit.correctedFromYahoo} · kept=${audit.keptAsEstimate}`,
      );
      if (!DRY) {
        // Flush shards + checkpoint.
        for (const s of shardsToWrite) {
          const [, ctx2] = [...targetsByTicker.entries()].find(([, v]) => v.shard === s) ?? [];
          if (!ctx2) continue;
          await writeShard(s, ctx2);
        }
        shardsToWrite.clear();
        await fs.writeFile(
          CKPT_PATH,
          JSON.stringify(
            { done: [...done], correctedFromSec: audit.correctedFromSec, correctedFromYahoo: audit.correctedFromYahoo, keptAsEstimate: audit.keptAsEstimate, perTicker: audit.perTicker },
            null,
            2,
          ),
        );
      }
    }
  };

  // Worker pool.
  let cursor = 0;
  const workers = Array.from({ length: YAHOO_CONCURRENCY }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= tickers.length) return;
      try { await processTicker(tickers[idx]); }
      catch (e) {
        console.error(`  ${tickers[idx]} error: ${e.message ?? e}`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`\n=== repair-shell-eventdates ===`);
  console.log(`Events scanned (on -15):       ${scanned15}`);
  console.log(`Corrected from SEC filing:     ${audit.correctedFromSec}`);
  console.log(`Corrected from Yahoo asOfDate: ${audit.correctedFromYahoo}`);
  console.log(`Kept as estimate (no source):  ${audit.keptAsEstimate}`);
  console.log(`Shards to write:               ${shardsToWrite.size}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "shell-eventdates-repair.json"), JSON.stringify(audit, null, 2));
  console.log(`✓ audit → scripts/audits/shell-eventdates-repair.json`);

  if (DRY) { console.log("[dry-run] shards NOT written"); return; }
  for (const shard of shardsToWrite) {
    const ticker = [...targetsByTicker.entries()].find(([, v]) => v.shard === shard)?.[0];
    if (!ticker) continue;
    await writeShard(shard, targetsByTicker.get(ticker).ctx);
  }
  console.log(`✓ updated ${shardsToWrite.size} shards`);
}

main().catch((e) => { console.error(e); process.exit(1); });
