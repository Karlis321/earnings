#!/usr/bin/env node
/**
 * DEPRECATED (shard-first): reads + writes data/earnings.json (gitignored).
 * Kept for the original bulk backfill that produced the monolith; new
 * events land in shards via cron. Re-run only against a reconstituted
 * monolith.
 *
 * Backfill past-4Q events for every operating universe ticker that has
 * zero events. Fetches yahooEarnings.earnings.{earningsChart,financialsChart}
 * per ticker (concurrency 6), constructs event records with EPS + revenue
 * actuals + baselines + horizon points, and appends to earnings.json.
 *
 * Mirrors the buildPastEvent + seedReactionPoints + baseline-seed logic
 * in the server code so the local snapshot ends up looking like what a
 * fresh cron run would produce.
 *
 *   node scripts/backfill-universe-events.mjs         # write
 *   node scripts/backfill-universe-events.mjs --dry   # report only
 *   node scripts/backfill-universe-events.mjs --limit=100
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS_PATH = path.join(ROOT, "data", "earnings.json");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : Infinity;
const CONCURRENCY = 6;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };

const METRIC_LABEL_BY_KEY = {
  revenue_usd_m: { label: "Revenue (M)", unit: "USD" },
  revenue_eur_m: { label: "Revenue (M)", unit: "EUR" },
  ebitda_usd_m: { label: "EBITDA (M)", unit: "USD" },
  adj_ebitda_usd_m: { label: "Adj. EBITDA (M)", unit: "USD" },
  eps_usd: { label: "EPS", unit: "USD" },
  eps_eur: { label: "EPS", unit: "EUR" },
  eps_cad: { label: "EPS", unit: "CAD" },
  dr_eps_usd: { label: "DR EPS", unit: "USD" },
};
function labelFor(key) {
  return METRIC_LABEL_BY_KEY[key] ?? { label: key, unit: "USD" };
}

let CRUMB = null;
let COOKIE_HEADER = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "manual",
  });
  const setCookies =
    typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of setCookies) {
    const f = raw.split(";", 1)[0].trim();
    const eq = f.indexOf("=");
    if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
  }
  COOKIE_HEADER = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE_HEADER) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
  });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchYahooEarnings(yahooSymbol) {
  await primeCrumb();
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}` +
    `?modules=earnings,calendarEvents&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.quoteSummary?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchYahooBars(yahooSymbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    `?interval=1d&range=1y`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
    }
    return bars;
  } catch {
    return [];
  }
}

function parseYahooPeriod(s) {
  const m = String(s ?? "").trim().match(/^(\d)Q(\d{4})$/);
  if (!m) return null;
  return { quarter: parseInt(m[1], 10), year: parseInt(m[2], 10) };
}
function reportingDateForPeriod(period) {
  const p = parseYahooPeriod(period);
  if (!p) return null;
  const monthAfterQEnd = { 1: 4, 2: 7, 3: 10, 4: 1 };
  const mo = monthAfterQEnd[p.quarter];
  const yr = p.quarter === 4 ? p.year + 1 : p.year;
  return `${yr}-${String(mo).padStart(2, "0")}-15`;
}
function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextEventId(ticker, date) {
  const slug = `${ticker.replace(/\s+/g, "_")}_${date}`.toLowerCase();
  const h = Math.abs(hash(slug)).toString(36).slice(0, 7);
  return `evt-${h}`;
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

// Baseline picker (matches server logic)
const BASELINE_TOLERANCE_DAYS = 7;
function pickBaselineIdx(bars, anchorDate, timing) {
  const anchorTs = new Date(anchorDate).getTime();
  const cutoff = anchorTs + BASELINE_TOLERANCE_DAYS * 86_400_000;
  const idx =
    timing === "AMC"
      ? bars.findIndex((b) => new Date(b.date).getTime() > anchorTs)
      : bars.findIndex((b) => new Date(b.date).getTime() >= anchorTs);
  if (idx < 0) return -1;
  if (new Date(bars[idx].date).getTime() > cutoff) return -1;
  return idx;
}

const OFFSETS = { d1: 1, d3: 3, w1: 5, m1: 21 };

function buildPastEvent(entity, q, yahooSymbol) {
  const parsed = parseYahooPeriod(q.period);
  if (!parsed) return null;
  const scheduledDate = reportingDateForPeriod(q.period);
  if (!scheduledDate) return null;
  const periodLabel = `FY${parsed.year} Q${parsed.quarter}`;
  const id = nextEventId(entity.ticker, scheduledDate);
  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);

  const earningsUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/earnings`;
  const financialsUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/financials`;
  const analysisUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/analysis`;

  const epsKeys = new Set(entity.headlineMetrics.filter((k) => /eps/i.test(k)));
  const includeStandaloneEps = epsKeys.size === 0 && q.actual != null;
  const keysToWrite = includeStandaloneEps
    ? [...entity.headlineMetrics, "eps_usd"]
    : entity.headlineMetrics;
  const revenueM = q.revenue != null ? q.revenue / 1_000_000 : null;

  const metrics = [];
  for (const key of keysToWrite) {
    const meta = labelFor(key);
    const isEps = /eps/i.test(key);
    const isRevenueM = /^revenue_[a-z]{3}_m$/.test(key);
    let estimateVal = null;
    let actualVal = null;
    let srcUrl = earningsUrl;
    let srcLabel = "Yahoo Finance · earnings";
    if (isEps) {
      estimateVal = q.estimate;
      actualVal = q.actual;
    } else if (isRevenueM) {
      actualVal = revenueM;
      srcUrl = financialsUrl;
      srcLabel = "Yahoo Finance · financials";
    }
    const surprisePct =
      estimateVal != null && actualVal != null && Math.abs(estimateVal) > 1e-9
        ? ((actualVal - estimateVal) / Math.abs(estimateVal)) * 100
        : null;
    metrics.push({
      key,
      displayLabel: meta.label,
      isHeadline: entity.headlineMetrics.includes(key),
      surprisePct,
      estimate:
        estimateVal != null
          ? { value: estimateVal, unit: meta.unit, source: { url: analysisUrl, label: "Yahoo Finance · consensus", provenance: "wire", locator: null }, asOf, fetchedAt: now, method: "yahoo", confidence: 0.75 }
          : null,
      actual:
        actualVal != null
          ? { value: actualVal, unit: meta.unit, source: { url: srcUrl, label: srcLabel, provenance: "wire", locator: null }, asOf, fetchedAt: now, method: "yahoo", confidence: 0.85 }
          : null,
      prior: null,
    });
  }

  const points = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: entity.benchmark ?? "",
    computedAt: null,
    populatesOn: addDays(scheduledDate, HORIZON_TRADING_DAYS[h] + 2),
  }));

  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period: periodLabel,
    scheduledDate,
    eventDate: scheduledDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    metrics,
    guidance: [],
    reaction: { benchmark: entity.benchmark ?? "", baselineDate: null, baselineClose: null, points },
    sources: { windowStart: addDays(scheduledDate, -2), windowEnd: addDays(scheduledDate, 35), capturedAt: null, items: [], engineStatus: [] },
  };
}

// Maturate baseline + horizons using bars
function matureEvent(event, bars, now) {
  if (bars.length === 0) return event;
  const anchor = event.eventDate ?? event.scheduledDate;
  const anchorHasPassed = anchor && new Date(anchor).getTime() <= now.getTime();
  if (!anchorHasPassed) return event;
  const idx = pickBaselineIdx(bars, anchor, event.timing);
  if (idx < 0) return event;
  const baselineDate = bars[idx].date;
  const baselineClose = bars[idx].close;
  const points = event.reaction.points.map((p) => {
    if (!p.populatesOn || new Date(p.populatesOn) > now) return p;
    const secIdx = idx + OFFSETS[p.horizon];
    if (secIdx >= bars.length) return p;
    const secClose = bars[secIdx].close;
    const absReturn = (secClose - baselineClose) / baselineClose;
    return { ...p, absReturn, excessReturn: null, computedAt: now.toISOString(), gapFlagged: true };
  });
  return { ...event, reaction: { ...event.reaction, baselineDate, baselineClose, points } };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log(`backfill-universe-events · dry=${DRY} limit=${LIMIT}`);
  // Prime crumb ONCE before pool workers start — otherwise 6 concurrent
  // fetchYahooEarnings calls all race the priming path and stomp on the
  // shared CRUMB / COOKIE_HEADER, which is why the first pass returned 19
  // "no response" out of 20.
  const c = await primeCrumb();
  if (!c) {
    console.error("Failed to prime crumb — aborting");
    process.exit(1);
  }
  console.log(`Crumb primed (${c.length} chars)`);

  const [regRaw, snapRaw] = await Promise.all([
    fs.readFile(REGISTRY_PATH, "utf-8"),
    fs.readFile(EARNINGS_PATH, "utf-8"),
  ]);
  const reg = JSON.parse(regRaw);
  const snap = JSON.parse(snapRaw);
  const eventTickers = new Set(snap.events.map((ev) => ev.ticker));

  // Universe operating tickers with no events
  const candidates = reg.entities.filter(
    (e) =>
      !e.isCore &&
      e.securityType === "operating" &&
      e.yahooSymbol &&
      !eventTickers.has(e.ticker),
  );
  const targets = candidates.slice(0, LIMIT);
  console.log(`Candidates: ${candidates.length} · processing: ${targets.length}`);

  const now = new Date();
  let addedEvents = 0;
  let noYahoo = 0;
  let noQuarters = 0;
  let succeeded = 0;

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 50 === 0) {
      console.log(`  [${idx}/${targets.length}] processed · +${addedEvents} events so far`);
    }
    const result = await fetchYahooEarnings(entity.yahooSymbol);
    if (!result) { noYahoo++; return; }
    const quarterlyRaw = result.earnings?.earningsChart?.quarterly ?? [];
    const financialsRaw = result.earnings?.financialsChart?.quarterly ?? [];
    if (quarterlyRaw.length === 0) { noQuarters++; return; }
    succeeded++;
    const finByPeriod = new Map();
    for (const f of financialsRaw) {
      if (!f.date) continue;
      finByPeriod.set(f.date, { revenue: f.revenue?.raw ?? null });
    }
    const bars = await fetchYahooBars(entity.yahooSymbol);
    for (const q of quarterlyRaw) {
      const actual = q.actual?.raw ?? null;
      const estimate = q.estimate?.raw ?? null;
      const fin = finByPeriod.get(q.date ?? "");
      let ev = buildPastEvent(entity, {
        period: q.date ?? "",
        actual,
        estimate,
        revenue: fin?.revenue ?? null,
      }, entity.yahooSymbol);
      if (!ev) continue;
      ev = matureEvent(ev, bars, now);
      snap.events.push(ev);
      addedEvents++;
    }
  });

  console.log(`\nSucceeded (had quarters): ${succeeded}`);
  console.log(`No yahoo response:        ${noYahoo}`);
  console.log(`No quarters returned:     ${noQuarters}`);
  console.log(`Events added:             ${addedEvents}`);
  console.log(`Total events now:         ${snap.events.length}`);

  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }
  await fs.writeFile(EARNINGS_PATH, JSON.stringify(snap, null, 2));
  console.log(`\n✓ wrote ${EARNINGS_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
