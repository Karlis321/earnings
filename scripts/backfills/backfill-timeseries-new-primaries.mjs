#!/usr/bin/env node
/**
 * TODO Item 4 — Yahoo-timeseries backfill for newly-added US primaries.
 *
 * Item 1 promoted 102 US listings to canonical (BRK-B US, AAPL US,
 * ASML US, TSM US, ANET US, …) but their shards are empty — their
 * companyId's events live on the foreign-wrapper shards
 * (AAPL MM, BRKB80 TB, ASMLN MM, …). SEC-verbatim rederive already
 * distributed 2020+ metrics to every listing at the metric level, but
 * pre-2020 history and event skeletons only live on the wrapper shard.
 *
 * This script targets the specific set of US-primary entities with no
 * own shard. For each, it:
 *   1. Fetches Yahoo fundamentals-timeseries via its Yahoo symbol.
 *   2. Groups by quarter, builds events, and writes them to the
 *      US-canonical shard (data/events/{TICKER}_US.json).
 *
 * The foreign-wrapper shard is left untouched — this only adds to the
 * new US-canonical location. Reshard-by-companyId is a separate task.
 *
 *   node scripts/backfill-timeseries-new-primaries.mjs [--dry]
 *   node scripts/backfill-timeseries-new-primaries.mjs --limit=20
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

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : Infinity;

const UA = "Mozilla/5.0 (backfill-timeseries)";
const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };
const INTERVAL_MS = 1500;
const TS_MAP = {
  quarterlyTotalRevenue: { key: "revenue_usd_m", label: "Revenue (M)", scale: 1e6 },
  quarterlyEBIT: { key: "ebit_usd_m", label: "EBIT (M)", scale: 1e6 },
  quarterlyOperatingIncome: { key: "operating_income_usd_m", label: "Operating income (M)", scale: 1e6 },
  quarterlyGrossProfit: { key: "gross_profit_usd_m", label: "Gross profit (M)", scale: 1e6 },
  quarterlyNetIncome: { key: "net_income_usd_m", label: "Net income (M)", scale: 1e6 },
  quarterlyBasicEPS: { key: "eps_usd", label: "EPS", scale: 1 },
  quarterlyDilutedEPS: { key: "eps_diluted_usd", label: "EPS diluted", scale: 1 },
};

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
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

async function fetchTimeseries(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 5 * 365 * 24 * 3600;
  const types = Object.keys(TS_MAP).join(",");
  const url =
    `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?type=${types}&period1=${from}&period2=${now}&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.timeseries?.result ?? [];
  } catch {
    return null;
  }
}

function collectByQuarter(seriesResults) {
  const byQuarter = new Map();
  for (const r of seriesResults) {
    const type = r.meta?.type?.[0];
    if (!type || !TS_MAP[type]) continue;
    const spec = TS_MAP[type];
    const dataKey = Object.keys(r).find((k) => k !== "meta" && k !== "timestamp");
    if (!dataKey) continue;
    const data = r[dataKey] ?? [];
    for (const d of data) {
      if (!d) continue;
      const asOfDate = d.asOfDate;
      const raw = d.reportedValue?.raw;
      if (asOfDate == null || raw == null) continue;
      if (d.periodType && d.periodType !== "3M") continue;
      if (!byQuarter.has(asOfDate)) byQuarter.set(asOfDate, new Map());
      const bucket = byQuarter.get(asOfDate);
      if (bucket.has(spec.key)) continue;
      bucket.set(spec.key, {
        value: raw / spec.scale,
        unit: d.currencyCode ?? "USD",
        label: spec.label,
      });
    }
  }
  return byQuarter;
}

function periodFromEndDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return { year: y, quarter: q, label: `FY${y} Q${q}` };
}
function addDays(iso, n) {
  const d = new Date(iso); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function hashId(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

function buildEvent(entity, asOfDate, bucket) {
  const { label: period } = periodFromEndDate(asOfDate);
  const now = new Date().toISOString();
  const id = hashId(`${entity.ticker}_${asOfDate}_${period}`);
  const metrics = [];
  for (const [k, d] of bucket) {
    metrics.push({
      key: k,
      displayLabel: d.label,
      isHeadline: entity.headlineMetrics?.includes(k) ?? false,
      surprisePct: null,
      estimate: null,
      actual: {
        value: d.value,
        unit: d.unit,
        source: {
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/financials`,
          label: "Yahoo · fundamentals-timeseries",
          provenance: "wire",
          locator: null,
        },
        asOf: asOfDate,
        fetchedAt: now,
        method: "yahoo",
        confidence: 0.85,
      },
      prior: null,
    });
  }
  const points = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: entity.benchmark ?? "",
    computedAt: null,
    populatesOn: addDays(asOfDate, HORIZON_TRADING_DAYS[h] + 2),
  }));
  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period,
    scheduledDate: asOfDate,
    eventDate: asOfDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "yahoo-timeseries",
    provenanceAsOf: now,
    metrics,
    guidance: [],
    reaction: { benchmark: entity.benchmark ?? "", baselineDate: null, baselineClose: null, points },
    sources: {
      windowStart: addDays(asOfDate, -2),
      windowEnd: addDays(asOfDate, 35),
      capturedAt: null,
      items: [],
      engineStatus: [],
    },
  };
}

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  console.log(`backfill-timeseries-new-primaries · dry=${DRY} limit=${LIMIT}`);
  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }
  console.log(`crumb=${CRUMB.slice(0, 6)}…`);

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const ents = reg.entities || [];

  const existingShards = new Set(
    (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")),
  );

  // Newly-added US primaries: canonical US listings that have no own shard
  // and have a Yahoo symbol (i.e., we could theoretically probe them).
  const targets = ents
    .filter((e) => e.ticker.endsWith(" US") && e.isCanonical !== false && e.yahooSymbol)
    .filter((e) => !existingShards.has(tickerSlug(e.ticker)))
    .filter((e) => e.securityType === "operating")
    .slice(0, LIMIT);

  console.log(`Targets (US canonicals with no shard, operating): ${targets.length}`);

  const audit = { generatedAt: new Date().toISOString(), targets: targets.length, ok: 0, empty: 0, err: 0, wrote: 0, perTicker: [] };
  for (const [i, e] of targets.entries()) {
    process.stdout.write(`  [${i + 1}/${targets.length}] ${e.ticker.padEnd(10)} → ${e.yahooSymbol.padEnd(8)}`);
    const series = await fetchTimeseries(e.yahooSymbol);
    if (!series || !Array.isArray(series)) {
      audit.err++;
      audit.perTicker.push({ ticker: e.ticker, yahoo: e.yahooSymbol, status: "err" });
      console.log(" [err]");
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }
    const byQuarter = collectByQuarter(series);
    if (byQuarter.size === 0) {
      audit.empty++;
      audit.perTicker.push({ ticker: e.ticker, yahoo: e.yahooSymbol, status: "empty" });
      console.log(" [empty]");
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }
    const events = [];
    for (const [asOfDate, bucket] of byQuarter) {
      events.push(buildEvent(e, asOfDate, bucket));
    }
    events.sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
    audit.ok++;
    audit.wrote += events.length;
    audit.perTicker.push({ ticker: e.ticker, yahoo: e.yahooSymbol, status: "ok", quarters: events.length });
    console.log(` [ok ${events.length}q]`);
    if (!DRY) {
      const outPath = path.join(EVENTS_DIR, tickerSlug(e.ticker) + ".json");
      await fs.writeFile(outPath, JSON.stringify({ events }, null, 2));
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  console.log(`\n=== backfill-timeseries-new-primaries ===`);
  console.log(`ok:    ${audit.ok}`);
  console.log(`empty: ${audit.empty}`);
  console.log(`err:   ${audit.err}`);
  console.log(`wrote: ${audit.wrote} events across ${audit.ok} shards`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const auditPath = path.join(OUT_DIR, "timeseries-new-primaries.json");
  await fs.writeFile(auditPath, JSON.stringify(audit, null, 2));
  console.log(`✓ audit → ${auditPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
