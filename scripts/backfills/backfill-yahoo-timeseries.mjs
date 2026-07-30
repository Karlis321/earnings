#!/usr/bin/env node
/**
 * DEPRECATED (shard-first): reads + writes data/earnings.json (gitignored).
 * Retained for archival re-runs against a reconstituted monolith.
 *
 * Backfill events + metric actuals from Yahoo's fundamentals-timeseries
 * endpoint. This is DIFFERENT from earningsChart / financialsChart — it
 * returns real per-quarter Revenue + EBIT + OperatingIncome + NetIncome +
 * Basic/Diluted EPS for tickers where earningsChart is empty (BN,
 * Canadian 40-F filers, foreign wrappers).
 *
 *   GET https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/
 *       finance/timeseries/{sym}?type=quarterlyTotalRevenue,quarterlyEBIT,
 *       quarterlyOperatingIncome,quarterlyNetIncome,quarterlyBasicEPS,
 *       quarterlyDilutedEPS&period1=...&period2=...&crumb=...
 *
 * For each entity with yahooSymbol:
 *   1. Fetch timeseries (last 5y).
 *   2. For each unique asOfDate, build a period label + metric bucket.
 *   3. If an event matches the period, enrich metric.actual where null.
 *   4. If no event, CREATE one with the timeseries actuals.
 *
 *   node scripts/backfill-yahoo-timeseries.mjs
 *   node scripts/backfill-yahoo-timeseries.mjs --dry
 *   node scripts/backfill-yahoo-timeseries.mjs --portfolio
 *   node scripts/backfill-yahoo-timeseries.mjs --limit=100
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const PORTFOLIO_ONLY = args.get("portfolio") === true;
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : Infinity;
const CONCURRENCY = 6;

const UA = "Mozilla/5.0";
const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
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

// Map timeseries type → our internal metric key + label + scale.
// Timeseries returns raw dollars for revenue/income/etc; EPS is already
// per-share. Currency is read from each data point's currencyCode field
// — NOT hardcoded USD (the .TO / .L / .DE issuers report in local
// currency and we need to track that per-metric).
const TS_MAP = {
  quarterlyTotalRevenue: { key: "revenue_usd_m", label: "Revenue (M)", scale: 1e6 },
  quarterlyEBIT: { key: "ebit_usd_m", label: "EBIT (M)", scale: 1e6 },
  quarterlyEBITDA: { key: "ebitda_usd_m", label: "EBITDA (M)", scale: 1e6 },
  quarterlyOperatingIncome: { key: "operating_income_usd_m", label: "Operating income (M)", scale: 1e6 },
  quarterlyGrossProfit: { key: "gross_profit_usd_m", label: "Gross profit (M)", scale: 1e6 },
  quarterlyNetIncome: { key: "net_income_usd_m", label: "Net income (M)", scale: 1e6 },
  quarterlyBasicEPS: { key: "eps_usd", label: "EPS", scale: 1 },
  quarterlyDilutedEPS: { key: "eps_diluted_usd", label: "EPS diluted", scale: 1 },
};

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
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.timeseries?.result ?? [];
  } catch {
    return null;
  }
}

// Merge per-quarter data across all requested types into a single
// Map<asOfDate, { metrics: Map<internalKey, {value, unit, label}> }>.
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
        unit: d.currencyCode ?? "USD", // real filing currency, not hardcoded
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
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

function buildFactForBucket(entity, asOfDate, metricSpec) {
  const now = new Date().toISOString();
  const sym = entity.yahooSymbol ?? "";
  return {
    value: metricSpec.value,
    unit: metricSpec.unit,
    source: {
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/financials`,
      label: "Yahoo · fundamentals-timeseries",
      provenance: "wire",
      locator: null,
    },
    asOf: asOfDate,
    fetchedAt: now,
    method: "yahoo",
    confidence: 0.85,
  };
}

function buildEventFromQuarter(entity, asOfDate, bucket) {
  const { label: period } = periodFromEndDate(asOfDate);
  const scheduledDate = asOfDate;
  const id = hashId(`${entity.ticker}_${scheduledDate}_${period}`);
  const metrics = [];
  for (const [metricKey, data] of bucket) {
    metrics.push({
      key: metricKey,
      displayLabel: data.label,
      isHeadline: entity.headlineMetrics?.includes(metricKey) ?? false,
      surprisePct: null,
      estimate: null,
      actual: buildFactForBucket(entity, asOfDate, data),
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
    period,
    scheduledDate,
    eventDate: scheduledDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "yahoo-timeseries",
    provenanceAsOf: new Date().toISOString(),
    metrics,
    guidance: [],
    reaction: { benchmark: entity.benchmark ?? "", baselineDate: null, baselineClose: null, points },
    sources: {
      windowStart: addDays(scheduledDate, -2),
      windowEnd: addDays(scheduledDate, 35),
      capturedAt: null,
      items: [],
      engineStatus: [],
    },
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`backfill-yahoo-timeseries · dry=${DRY} portfolio=${PORTFOLIO_ONLY} limit=${LIMIT}`);
  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }

  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));

  let targets = reg.entities.filter((e) => e.securityType === "operating" && e.yahooSymbol);
  if (PORTFOLIO_ONLY) targets = targets.filter((e) => e.isCore);
  targets = targets.slice(0, LIMIT);
  console.log(`Targets: ${targets.length}`);

  const eventsByTicker = new Map();
  for (const ev of snap.events) {
    if (!eventsByTicker.has(ev.ticker)) eventsByTicker.set(ev.ticker, []);
    eventsByTicker.get(ev.ticker).push(ev);
  }

  let entitiesTouched = 0;
  let eventsCreated = 0;
  let metricsAdded = 0;
  let noResponse = 0;
  let noQuarters = 0;

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 100 === 0) {
      console.log(`  [${idx}/${targets.length}] · +${eventsCreated} events · +${metricsAdded} metrics`);
    }
    const seriesResults = await fetchTimeseries(entity.yahooSymbol);
    if (!seriesResults) { noResponse++; return; }
    const byQuarter = collectByQuarter(seriesResults);
    if (byQuarter.size === 0) { noQuarters++; return; }

    const existing = eventsByTicker.get(entity.ticker) ?? [];
    let touched = false;
    for (const [asOfDate, bucket] of byQuarter) {
      const { year, quarter, label } = periodFromEndDate(asOfDate);
      // Merge key: (ticker, fiscalPeriod) OR (ticker, close-date within
      // 45d). The close-date fallback catches fiscal-calendar offset
      // cases where SEC XBRL uses the issuer's fiscal Q3 (Nov) but Yahoo
      // uses calendar Q3 (Sep) for the same underlying report — same
      // event, different period label.
      const targetTs = new Date(asOfDate).getTime();
      const matchingEvent =
        existing.find((ev) => {
          const m = /^FY(\d{4})\s+Q(\d)$/.exec(ev.period ?? "");
          return m && Number(m[1]) === year && Number(m[2]) === quarter;
        }) ??
        existing.find((ev) => {
          if (!ev.eventDate) return false;
          const evTs = new Date(ev.eventDate).getTime();
          return Math.abs(evTs - targetTs) / 86_400_000 <= 45;
        });
      if (matchingEvent) {
        // Refresh eventDate when it's a shell placeholder (mid-month
        // 15th from the estimator) and the timeseries asOfDate is a
        // real quarter-end. Same rule as mergeMetricsInto in the cron
        // — the July-2026 audit found 1,765 events stuck with the
        // 15th because this enrichment step never touched eventDate.
        if (
          /-15$/.test(matchingEvent.eventDate ?? "") &&
          !/-15$/.test(asOfDate)
        ) {
          matchingEvent.eventDate = asOfDate;
          matchingEvent.eventDateSource = "yahoo-timeseries-asOfDate";
        }
        // Enrich existing event's metrics — fill actuals where null.
        if (!Array.isArray(matchingEvent.metrics)) matchingEvent.metrics = [];
        for (const [metricKey, data] of bucket) {
          const existingMetric = matchingEvent.metrics.find((m) => m.key === metricKey);
          if (existingMetric && existingMetric.actual?.value != null) continue;
          const fact = buildFactForBucket(entity, asOfDate, data);
          if (existingMetric) {
            existingMetric.actual = fact;
          } else {
            matchingEvent.metrics.push({
              key: metricKey,
              displayLabel: data.label,
              isHeadline: entity.headlineMetrics?.includes(metricKey) ?? false,
              surprisePct: null,
              estimate: null,
              actual: fact,
              prior: null,
            });
          }
          metricsAdded++;
          touched = true;
        }
      } else {
        // No matching event → create one.
        const ev = buildEventFromQuarter(entity, asOfDate, bucket);
        snap.events.push(ev);
        existing.push(ev);
        eventsCreated++;
        touched = true;
      }
    }
    if (touched) entitiesTouched++;
  });

  console.log(`\nEntities touched: ${entitiesTouched}`);
  console.log(`Events created:   ${eventsCreated}`);
  console.log(`Metrics added:    ${metricsAdded}`);
  console.log(`No response:      ${noResponse}`);
  console.log(`No quarters:      ${noQuarters}`);
  console.log(`Total events now: ${snap.events.length}`);

  if (DRY) { console.log("Dry run — no write."); return; }
  await fs.writeFile(EARNINGS, JSON.stringify(snap, null, 2));
  console.log(`✓ wrote ${EARNINGS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
