#!/usr/bin/env node
/**
 * Enrich past-event metrics with SEC XBRL company-facts data.
 *
 * For each entity with edgarCik, fetch
 *   https://data.sec.gov/api/xbrl/companyfacts/CIK{padded10}.json
 *
 * Extract PURE-QUARTER entries (start-end span ~80-100 days, form 10-Q
 * or 6-K) for:
 *
 *   us-gaap:  Revenues, RevenueFromContractWithCustomerExcludingAssessedTax,
 *             GrossProfit, OperatingIncomeLoss, NetIncomeLoss,
 *             EarningsPerShareBasic, EarningsPerShareDiluted
 *   ifrs-full: Revenue, GrossProfit, ProfitLoss,
 *              ProfitLossFromOperatingActivities,
 *              BasicEarningsLossPerShare, DilutedEarningsLossPerShare
 *
 * Map end-date → FY{year} Q{quarter}. For each matching past event on
 * the entity, inject a metric row with the SEC-XBRL source URL. Only
 * inject if the target metric key is either already null OR not yet
 * present on the event.
 *
 *   node scripts/backfill-sec-metrics.mjs         # write
 *   node scripts/backfill-sec-metrics.mjs --dry
 *   node scripts/backfill-sec-metrics.mjs --portfolio
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
const PORTFOLIO_ONLY = args.get("portfolio") === true;
const CONCURRENCY = 3;
const SEC_UA = "Earnings Tracker (contact@example.com)";

// XBRL key -> our internal metric key + display label + unit
// Ordered by preference (Revenues before RevenueFromContract). First
// hit wins per event/quarter.
const XBRL_MAP = [
  // Revenue
  { xbrl: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"], taxonomy: "us-gaap", key: "revenue_usd_m", label: "Revenue (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["Revenue"], taxonomy: "ifrs-full", key: "revenue_usd_m", label: "Revenue (M)", unit: "USD", scale: 1e6 },
  // Gross profit
  { xbrl: ["GrossProfit"], taxonomy: "us-gaap", key: "gross_profit_usd_m", label: "Gross profit (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["GrossProfit"], taxonomy: "ifrs-full", key: "gross_profit_usd_m", label: "Gross profit (M)", unit: "USD", scale: 1e6 },
  // Operating income (proxy for EBIT)
  { xbrl: ["OperatingIncomeLoss"], taxonomy: "us-gaap", key: "operating_income_usd_m", label: "Operating income (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["ProfitLossFromOperatingActivities"], taxonomy: "ifrs-full", key: "operating_income_usd_m", label: "Operating income (M)", unit: "USD", scale: 1e6 },
  // Net income
  { xbrl: ["NetIncomeLoss"], taxonomy: "us-gaap", key: "net_income_usd_m", label: "Net income (M)", unit: "USD", scale: 1e6 },
  { xbrl: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"], taxonomy: "ifrs-full", key: "net_income_usd_m", label: "Net income (M)", unit: "USD", scale: 1e6 },
  // EPS (basic preferred; diluted as fallback)
  { xbrl: ["EarningsPerShareBasic"], taxonomy: "us-gaap", key: "eps_usd", label: "EPS", unit: "USD", scale: 1 },
  { xbrl: ["EarningsPerShareDiluted"], taxonomy: "us-gaap", key: "eps_diluted_usd", label: "EPS diluted", unit: "USD", scale: 1 },
  { xbrl: ["BasicEarningsLossPerShare"], taxonomy: "ifrs-full", key: "eps_usd", label: "EPS", unit: "USD", scale: 1 },
  { xbrl: ["DilutedEarningsLossPerShare"], taxonomy: "ifrs-full", key: "eps_diluted_usd", label: "EPS diluted", unit: "USD", scale: 1 },
];

// Parse end-date (YYYY-MM-DD) → FY{year} Q{quarter}. Assumes calendar
// quarters; not accurate for issuers with non-standard fiscal years.
// For those, the XBRL entry's own fy/fp fields carry the truth.
function endDateToPeriod(endStr, fy, fp) {
  // If fp = Q1..Q4 and fy is set, use those directly.
  if (fp && /^Q[1-4]$/.test(fp) && fy) {
    return { year: Number(fy), quarter: Number(fp.slice(1)) };
  }
  // Otherwise, derive calendar quarter from end date.
  const d = new Date(endStr);
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  const q = Math.floor(m / 3) + 1;
  return { year: y, quarter: q };
}

function isPureQuarter(v) {
  if (!v.start || !v.end) return false;
  const d1 = new Date(v.start);
  const d2 = new Date(v.end);
  const days = (d2 - d1) / 86_400_000;
  // 80-100 days catches every calendar quarter (89-92 days).
  return days >= 80 && days <= 100;
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

// From a companyfacts JSON, produce a Map<`${year}-Q${q}`, Map<metricKey, {value, unit, source}>>
function extractQuarterlyMetrics(facts, cik) {
  const out = new Map();
  const paddedCik = String(cik).padStart(10, "0");
  for (const spec of XBRL_MAP) {
    const taxo = facts.facts?.[spec.taxonomy];
    if (!taxo) continue;
    for (const xbrlKey of spec.xbrl) {
      const item = taxo[xbrlKey];
      if (!item) continue;
      const units = item.units ?? {};
      // Pick USD or USD/shares unit; fall back to first available.
      const preferredUnits = ["USD", "USD/shares"];
      const unitKey = preferredUnits.find((u) => units[u]) ?? Object.keys(units)[0];
      if (!unitKey) continue;
      const values = units[unitKey] ?? [];
      for (const v of values) {
        if (!isPureQuarter(v)) continue;
        if (!["10-Q", "10-K/A", "10-Q/A", "6-K", "6-K/A"].includes(v.form))
          continue;
        const { year, quarter } = endDateToPeriod(v.end, v.fy, v.fp);
        const periodKey = `${year}-Q${quarter}`;
        if (!out.has(periodKey)) out.set(periodKey, new Map());
        const bucket = out.get(periodKey);
        // First-hit wins per metric key.
        if (bucket.has(spec.key)) continue;
        // XBRL values are in native units — scale for our _m keys.
        const scaledValue = v.val / spec.scale;
        bucket.set(spec.key, {
          value: scaledValue,
          unit: spec.unit,
          label: spec.label,
          xbrlKey,
          taxonomy: spec.taxonomy,
          accession: v.accn,
          form: v.form,
          filed: v.filed,
        });
      }
      break; // stop trying alternate xbrl keys once one produced hits
    }
  }
  return out;
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
  console.log(`backfill-sec-metrics · dry=${DRY} portfolio=${PORTFOLIO_ONLY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));

  let targets = reg.entities.filter((e) => e.edgarCik);
  if (PORTFOLIO_ONLY) targets = targets.filter((e) => e.isCore);
  console.log(`Targets (entities with edgarCik): ${targets.length}`);

  const eventsByTicker = new Map();
  for (const ev of snap.events) {
    if (!eventsByTicker.has(ev.ticker)) eventsByTicker.set(ev.ticker, []);
    eventsByTicker.get(ev.ticker).push(ev);
  }

  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);
  let entitiesEnriched = 0;
  let eventsTouched = 0;
  let metricsAdded = 0;
  let noFacts = 0;
  let noQuarters = 0;

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 25 === 0) {
      console.log(`  [${idx}/${targets.length}] entities processed · +${metricsAdded} metrics so far`);
    }
    const facts = await fetchFacts(entity.edgarCik);
    if (!facts) { noFacts++; return; }
    const quarterly = extractQuarterlyMetrics(facts, entity.edgarCik);
    if (quarterly.size === 0) { noQuarters++; return; }
    const events = eventsByTicker.get(entity.ticker) ?? [];
    if (events.length === 0) return;

    entitiesEnriched++;
    for (const ev of events) {
      // Parse ev.period ("FY2026 Q1") to (year, quarter)
      const m = /^FY(\d{4})\s+Q(\d)$/.exec(ev.period);
      if (!m) continue;
      const key = `${m[1]}-Q${m[2]}`;
      const bucket = quarterly.get(key);
      if (!bucket) continue;

      let addedForEvent = 0;
      // Ensure metrics array
      if (!Array.isArray(ev.metrics)) ev.metrics = [];
      for (const [metricKey, data] of bucket) {
        const existing = ev.metrics.find((mm) => mm.key === metricKey);
        if (existing && existing.actual?.value != null) continue; // don't overwrite
        const sourceUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(entity.edgarCik).padStart(10, "0")}&type=${encodeURIComponent(data.form)}`;
        const fact = {
          value: data.value,
          unit: data.unit,
          source: {
            url: sourceUrl,
            label: `SEC EDGAR · ${data.form} · ${data.xbrlKey}`,
            provenance: "regulatory",
            locator: null,
          },
          asOf,
          fetchedAt: now,
          method: "filing_manual",
          confidence: 0.98,
        };
        if (existing) {
          existing.actual = fact;
        } else {
          ev.metrics.push({
            key: metricKey,
            displayLabel: data.label,
            isHeadline: entity.headlineMetrics?.includes(metricKey) ?? false,
            surprisePct: null,
            estimate: null,
            actual: fact,
            prior: null,
          });
        }
        addedForEvent++;
        metricsAdded++;
      }
      if (addedForEvent > 0) eventsTouched++;
    }
  });

  console.log(`\nEntities enriched:   ${entitiesEnriched}`);
  console.log(`Events touched:      ${eventsTouched}`);
  console.log(`Metrics added:       ${metricsAdded}`);
  console.log(`No SEC facts JSON:   ${noFacts}`);
  console.log(`No quarterly data:   ${noQuarters}`);

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
