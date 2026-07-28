#!/usr/bin/env node
/**
 * Create past events for entities that have edgarCik but no past
 * events (Yahoo returned nothing for those listings — foreign wrappers,
 * ADRs). Uses SEC XBRL company-facts to construct the events with
 * per-quarter Revenue, GrossProfit, OperatingIncome, NetIncome, EPS.
 *
 *   node scripts/backfill-sec-events.mjs         # write
 *   node scripts/backfill-sec-events.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const EARNINGS = path.join(ROOT, "data", "earnings.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const CONCURRENCY = 3;
const SEC_UA = "Earnings Tracker (contact@example.com)";

const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };

const XBRL_MAP = [
  { xbrl: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"], taxonomy: "us-gaap", key: "revenue_usd_m", label: "Revenue (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["Revenue"], taxonomy: "ifrs-full", key: "revenue_usd_m", label: "Revenue (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["GrossProfit"], taxonomy: "us-gaap", key: "gross_profit_usd_m", label: "Gross profit (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["GrossProfit"], taxonomy: "ifrs-full", key: "gross_profit_usd_m", label: "Gross profit (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["OperatingIncomeLoss"], taxonomy: "us-gaap", key: "operating_income_usd_m", label: "Operating income (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["ProfitLossFromOperatingActivities"], taxonomy: "ifrs-full", key: "operating_income_usd_m", label: "Operating income (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["NetIncomeLoss"], taxonomy: "us-gaap", key: "net_income_usd_m", label: "Net income (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"], taxonomy: "ifrs-full", key: "net_income_usd_m", label: "Net income (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["EarningsPerShareBasic"], taxonomy: "us-gaap", key: "eps_usd", label: "EPS", unit: "USD", scale: 1 },
  { xbrl: ["BasicEarningsLossPerShare"], taxonomy: "ifrs-full", key: "eps_usd", label: "EPS", unit: "USD", scale: 1 },
  { xbrl: ["EarningsPerShareDiluted"], taxonomy: "us-gaap", key: "eps_diluted_usd", label: "EPS diluted", unit: "USD", scale: 1 },
  { xbrl: ["DilutedEarningsLossPerShare"], taxonomy: "ifrs-full", key: "eps_diluted_usd", label: "EPS diluted", unit: "USD", scale: 1 },
];

function isPureQuarter(v) {
  if (!v.start || !v.end) return false;
  const d1 = new Date(v.start);
  const d2 = new Date(v.end);
  const days = (d2 - d1) / 86_400_000;
  return days >= 80 && days <= 100;
}

function endDateToPeriod(endStr, fy, fp) {
  if (fp && /^Q[1-4]$/.test(fp) && fy) {
    return { year: Number(fy), quarter: Number(fp.slice(1)) };
  }
  const d = new Date(endStr);
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  const q = Math.floor(m / 3) + 1;
  return { year: y, quarter: q };
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

async function fetchFacts(cik) {
  const padded = String(cik).padStart(10, "0");
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function extractQuarterlyMetrics(facts) {
  const out = new Map();
  for (const spec of XBRL_MAP) {
    const taxo = facts.facts?.[spec.taxonomy];
    if (!taxo) continue;
    for (const xbrlKey of spec.xbrl) {
      const item = taxo[xbrlKey];
      if (!item) continue;
      const units = item.units ?? {};
      const preferredUnits = ["USD", "USD/shares"];
      const unitKey = preferredUnits.find((u) => units[u]) ?? Object.keys(units)[0];
      if (!unitKey) continue;
      const values = units[unitKey] ?? [];
      for (const v of values) {
        if (!isPureQuarter(v)) continue;
        if (!["10-Q", "10-K/A", "10-Q/A", "6-K", "6-K/A"].includes(v.form)) continue;
        const { year, quarter } = endDateToPeriod(v.end, v.fy, v.fp);
        const periodKey = `${year}-Q${quarter}`;
        if (!out.has(periodKey)) out.set(periodKey, { end: v.end, filed: v.filed, form: v.form, accession: v.accn, metrics: new Map() });
        const bucket = out.get(periodKey);
        if (bucket.metrics.has(spec.key)) continue;
        bucket.metrics.set(spec.key, {
          value: v.val / spec.scale,
          unit: spec.unit,
          label: spec.label,
          xbrlKey,
          taxonomy: spec.taxonomy,
        });
      }
      break;
    }
  }
  return out;
}

function buildEventFromXbrl(entity, periodKey, bucket) {
  const [yStr, qStr] = periodKey.split("-Q");
  const year = parseInt(yStr, 10);
  const quarter = parseInt(qStr, 10);
  const period = `FY${year} Q${quarter}`;
  // Filing date (`filed`) is the report date. Use it as scheduledDate.
  const scheduledDate = bucket.filed || bucket.end;
  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);
  const paddedCik = String(entity.edgarCik).padStart(10, "0");
  const secBaseUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(bucket.form)}`;

  const metrics = [];
  for (const [metricKey, data] of bucket.metrics) {
    metrics.push({
      key: metricKey,
      displayLabel: data.label,
      isHeadline: entity.headlineMetrics?.includes(metricKey) ?? false,
      surprisePct: null,
      estimate: null,
      actual: {
        value: data.value,
        unit: data.unit,
        source: {
          url: secBaseUrl,
          label: `SEC EDGAR · ${bucket.form} · ${data.xbrlKey}`,
          provenance: "regulatory",
          locator: null,
        },
        asOf,
        fetchedAt: now,
        method: "filing_manual",
        confidence: 0.98,
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
    populatesOn: addDays(scheduledDate, HORIZON_TRADING_DAYS[h] + 2),
  }));

  return {
    id: hashId(`${entity.ticker}_${scheduledDate}_${periodKey}`),
    ticker: entity.ticker,
    kind: "earnings",
    period,
    scheduledDate,
    eventDate: scheduledDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "sec-xbrl-companyfacts",
    provenanceAsOf: new Date().toISOString(),
    metrics,
    guidance: [],
    reaction: {
      benchmark: entity.benchmark ?? "",
      baselineDate: null,
      baselineClose: null,
      points,
    },
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
  console.log(`backfill-sec-events · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));

  const pastEventTickers = new Set(
    snap.events.filter((ev) => ev.eventDate).map((ev) => ev.ticker),
  );
  const targets = reg.entities.filter(
    (e) =>
      e.edgarCik &&
      e.securityType === "operating" &&
      !pastEventTickers.has(e.ticker),
  );
  console.log(`Targets (edgarCik + no past events): ${targets.length}`);

  // Index existing events per ticker so we can merge-by-period rather
  // than blindly push. Even though the target filter above excludes
  // tickers with past events today, the same script is safe to re-run
  // against a ticker that gained events between runs (yahoo-timeseries
  // ran first, then sec-events ran) — we still merge into the existing
  // event on matching period label OR close eventDate (fiscal-calendar
  // offset).
  const eventsByTicker = new Map();
  for (const ev of snap.events) {
    if (!eventsByTicker.has(ev.ticker)) eventsByTicker.set(ev.ticker, []);
    eventsByTicker.get(ev.ticker).push(ev);
  }

  const now = new Date();
  let eventsCreated = 0;
  let eventsMerged = 0;
  let entitiesEnriched = 0;
  let noFacts = 0;
  let noQuarters = 0;

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 25 === 0) {
      console.log(`  [${idx}/${targets.length}] processed · +${eventsCreated} events`);
    }
    const facts = await fetchFacts(entity.edgarCik);
    if (!facts) { noFacts++; return; }
    const quarterly = extractQuarterlyMetrics(facts);
    if (quarterly.size === 0) { noQuarters++; return; }
    // Take last 4 quarters
    const sorted = [...quarterly.entries()].sort((a, b) => b[1].end.localeCompare(a[1].end));
    const lastFour = sorted.slice(0, 4);
    const existing = eventsByTicker.get(entity.ticker) ?? [];
    let created = 0;
    for (const [periodKey, bucket] of lastFour) {
      const ev = buildEventFromXbrl(entity, periodKey, bucket);
      // Merge key = (ticker, fiscalPeriod) OR (ticker, close-date within
      // 45d). The close-date fallback catches fiscal-calendar offset
      // (SEC XBRL fiscal-Q vs Yahoo calendar-Q for the same report).
      const evTs = new Date(ev.eventDate).getTime();
      const match =
        existing.find((e) => e.period === ev.period) ??
        existing.find((e) => {
          if (!e.eventDate) return false;
          const eTs = new Date(e.eventDate).getTime();
          return Math.abs(eTs - evTs) / 86_400_000 <= 45;
        });
      if (match) {
        // Enrich existing event's metrics — fill actuals where null.
        for (const m of ev.metrics ?? []) {
          const exM = (match.metrics ?? []).find((x) => x.key === m.key);
          if (exM && exM.actual?.value != null) continue;
          if (exM) exM.actual = m.actual;
          else {
            if (!Array.isArray(match.metrics)) match.metrics = [];
            match.metrics.push(m);
          }
        }
        eventsMerged++;
        continue;
      }
      snap.events.push(ev);
      existing.push(ev);
      eventsCreated++;
      created++;
    }
    if (created > 0) entitiesEnriched++;
  });

  console.log(`\nEntities enriched:   ${entitiesEnriched}`);
  console.log(`Events created:      ${eventsCreated}`);
  console.log(`Events merged:       ${eventsMerged}`);
  console.log(`No SEC facts:        ${noFacts}`);
  console.log(`No quarterly data:   ${noQuarters}`);
  console.log(`Total events now:    ${snap.events.length}`);

  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }
  await fs.writeFile(EARNINGS, JSON.stringify(snap, null, 2));
  console.log(`✓ wrote ${EARNINGS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
