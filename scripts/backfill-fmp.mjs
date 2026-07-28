#!/usr/bin/env node
/**
 * FMP fallback backfill. Runs once per day (250 req/day free tier),
 * targeting the tickers that STILL have no past events after Yahoo
 * timeseries + SEC XBRL passes. Chunk the run across multiple days:
 *
 *   node scripts/backfill-fmp.mjs                    # first 200 gaps
 *   node scripts/backfill-fmp.mjs --limit=200        # explicit limit
 *   node scripts/backfill-fmp.mjs --offset=200       # next chunk
 *   node scripts/backfill-fmp.mjs --dry              # report only, no HTTP
 *
 * Requires: FMP_API_KEY in env (register free at
 * https://site.financialmodelingprep.com/developer).
 *
 * Set it via a project-root .env file and run with:
 *   node --env-file=.env scripts/backfill-fmp.mjs
 *
 * Uses FMP's income-statement endpoint for revenue / EPS / EBITDA /
 * operatingIncome / grossProfit / netIncome per quarter. Fails soft:
 * a 403 / rate-limit / 5xx on any single ticker doesn't kill the run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : 200;
const OFFSET = args.get("offset") ? parseInt(args.get("offset"), 10) : 0;
const CONCURRENCY = 3;

const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };

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
function periodFromDate(iso) {
  const d = new Date(iso);
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 };
}

// FMP moved from /api/v3/ to /stable/ on 2025-08-31. The stable endpoint
// takes `symbol` as a query param and renames `epsdiluted` → `epsDiluted`.
// Free tier is US primary listings only — foreign symbols return HTTP 402
// ("Premium Query Parameter"). We treat 402 as a skip, not an error, so
// the run summary distinguishes "tier gates this" from "network/500".
async function fmpIncomeStatement(symbol, apiKey) {
  const url =
    `https://financialmodelingprep.com/stable/income-statement` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&period=quarter&limit=8&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 402) return { skip: "free-tier" };
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    if (!Array.isArray(j)) return { error: "not-an-array" };
    return { rows: j };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

function factFor(entity, quarter, key, value, unit, label) {
  if (value == null) return null;
  const now = new Date().toISOString();
  const sym = entity.yahooSymbol ?? entity.ticker.split(" ")[0];
  return {
    key,
    displayLabel: label,
    isHeadline: entity.headlineMetrics?.includes(key) ?? false,
    surprisePct: null,
    estimate: null,
    actual: {
      value,
      unit,
      source: {
        url: `https://financialmodelingprep.com/financial-statements/${encodeURIComponent(sym)}`,
        label: "FMP · income statement · quarterly",
        provenance: "wire",
        locator: null,
      },
      asOf: quarter.date,
      fetchedAt: now,
      method: "yahoo", // reuse the enum — this is machine-fetched not manual
      confidence: 0.85,
    },
    prior: null,
  };
}

function buildEventFromFmpQuarter(entity, quarter) {
  const { year, quarter: qNum } = periodFromDate(quarter.date);
  const period = `FY${year} Q${qNum}`;
  const id = hashId(`${entity.ticker}_${quarter.date}_${period}`);
  // Preserve the reporting currency — the /stable/ endpoint returns it as
  // reportedCurrency. Cross-ticker aggregations should never mix these.
  const currency = quarter.reportedCurrency ?? "USD";
  const metrics = [];
  const revenueM = quarter.revenue != null ? quarter.revenue / 1e6 : null;
  const ebitdaM = quarter.ebitda != null ? quarter.ebitda / 1e6 : null;
  const opIncM = quarter.operatingIncome != null ? quarter.operatingIncome / 1e6 : null;
  const grossM = quarter.grossProfit != null ? quarter.grossProfit / 1e6 : null;
  const netIncM = quarter.netIncome != null ? quarter.netIncome / 1e6 : null;
  const facts = [
    factFor(entity, quarter, "revenue_usd_m", revenueM, currency, "Revenue (M)"),
    factFor(entity, quarter, "ebitda_usd_m", ebitdaM, currency, "EBITDA (M)"),
    factFor(entity, quarter, "operating_income_usd_m", opIncM, currency, "Operating income (M)"),
    factFor(entity, quarter, "gross_profit_usd_m", grossM, currency, "Gross profit (M)"),
    factFor(entity, quarter, "net_income_usd_m", netIncM, currency, "Net income (M)"),
    factFor(entity, quarter, "eps_usd", quarter.eps, currency, "EPS"),
    factFor(entity, quarter, "eps_diluted_usd", quarter.epsDiluted, currency, "EPS diluted"),
  ].filter(Boolean);
  metrics.push(...facts);
  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period,
    scheduledDate: quarter.date,
    eventDate: quarter.date,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "fmp",
    provenanceAsOf: new Date().toISOString(),
    metrics,
    guidance: [],
    reaction: {
      benchmark: entity.benchmark ?? "",
      baselineDate: null,
      baselineClose: null,
      points: HORIZONS.map((h) => ({
        horizon: h,
        absReturn: null,
        excessReturn: null,
        benchmark: entity.benchmark ?? "",
        computedAt: null,
        populatesOn: addDays(quarter.date, HORIZON_TRADING_DAYS[h] + 2),
      })),
    },
    sources: {
      windowStart: addDays(quarter.date, -2),
      windowEnd: addDays(quarter.date, 35),
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
  const apiKey = process.env.FMP_API_KEY;
  console.log(
    `backfill-fmp · dry=${DRY} limit=${LIMIT} offset=${OFFSET} key=${apiKey ? "set" : "MISSING"}`,
  );
  if (!apiKey && !DRY) {
    console.error("FMP_API_KEY not set. Register at https://site.financialmodelingprep.com/developer");
    console.error("Then: export FMP_API_KEY=... (or set in your shell / .env)");
    process.exit(1);
  }

  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));

  const pastTickers = new Set(
    snap.events.filter((ev) => ev.eventDate).map((ev) => ev.ticker),
  );
  // Target: operating tickers with yahooSymbol, no past events yet.
  // Sort by ticker so successive --offset chunks are deterministic.
  const allGap = reg.entities
    .filter(
      (e) =>
        e.securityType === "operating" &&
        e.yahooSymbol &&
        !pastTickers.has(e.ticker),
    )
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  const targets = allGap.slice(OFFSET, OFFSET + LIMIT);
  console.log(`Total gap: ${allGap.length} · slice ${OFFSET}..${OFFSET + targets.length}`);

  if (DRY) {
    console.log("\nFirst 10 targets:");
    for (const e of targets.slice(0, 10)) {
      console.log(`  ${e.ticker.padEnd(14)} yahoo=${e.yahooSymbol}`);
    }
    return;
  }

  let entitiesEnriched = 0;
  let eventsCreated = 0;
  let noRows = 0;
  let errs = 0;
  let freeTierSkips = 0;

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 25 === 0) {
      console.log(`  [${idx}/${targets.length}] · +${eventsCreated} events`);
    }
    // FMP accepts Yahoo-suffix form for most foreign listings.
    const symbol = entity.yahooSymbol;
    const { rows, error, skip } = await fmpIncomeStatement(symbol, apiKey);
    if (skip) { freeTierSkips++; return; }
    if (error) { errs++; return; }
    if (!rows || rows.length === 0) { noRows++; return; }
    // Take last 4 quarters
    rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    let created = 0;
    for (const q of rows.slice(0, 4)) {
      if (!q.date) continue;
      const ev = buildEventFromFmpQuarter(entity, q);
      snap.events.push(ev);
      eventsCreated++;
      created++;
    }
    if (created > 0) entitiesEnriched++;
  });

  console.log(`\nEntities enriched: ${entitiesEnriched}`);
  console.log(`Events created:    ${eventsCreated}`);
  console.log(`No rows:           ${noRows}`);
  console.log(`Free-tier skips:   ${freeTierSkips}  (foreign listings gated behind FMP paid tier)`);
  console.log(`Errors:            ${errs}`);
  console.log(`Total events now:  ${snap.events.length}`);

  await fs.writeFile(EARNINGS, JSON.stringify(snap, null, 2));
  console.log(`✓ wrote ${EARNINGS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
