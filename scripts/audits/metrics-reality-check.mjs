#!/usr/bin/env node
/**
 * Universe-wide multi-metric audit against SEC XBRL.
 *
 * For every SP500 ∪ R1000 CIK-bearing operating ticker: fetch SEC
 * companyfacts, then for each of the 15 metric families in XBRL_MAP
 * (revenue, EPS basic/diluted, gross profit, operating income,
 * net income, cash, debt, equity, cash flow, capex, shares) compare
 * the stored metric value on each event to SEC's matching pure-quarter
 * (or instant) fact. Flag any mismatch >5%.
 *
 * Sibling of scripts/audits/revenue-reality-check.mjs — same match
 * pattern (filed-date proximity + reporting-quarter vs comparative
 * disambiguation), just widened to every metric.
 *
 * READ-ONLY. Writes only scripts/audits/metrics-reality-check.json.
 * Rate limit: 2 req/s per companyfacts fetch (SEC fair-access allows
 * 10 req/s; we stay well under). Runtime typical ~25-30 min for
 * 1600 CIKs.
 *
 *   node scripts/audits/metrics-reality-check.mjs
 *   node scripts/audits/metrics-reality-check.mjs --scope=sp500
 *   node scripts/audits/metrics-reality-check.mjs --ticker="NVDA US"
 *   node scripts/audits/metrics-reality-check.mjs --limit=50
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_PATH = path.join(__dirname, "metrics-reality-check.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;
const ONLY_TICKER = args.get("ticker") ? String(args.get("ticker")) : null;
const SCOPE = args.get("scope") ? String(args.get("scope")) : "sp500-r1000";
const DELTA_FLAG_PCT = 5;
const REQ_TIMEOUT_MS = 15_000;
const RATE_LIMIT_MS = 500;
const UA = `Earnings Tracker (${process.env.EDGAR_CONTACT_EMAIL || "klpp@bluorbank.lv"})`;

// XBRL concept map — mirror of scripts/backfills/rederive-sec-xbrl.mjs.
// Keep in sync when new metrics are added there.
const XBRL_MAP = [
  { keys: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"], taxo: "us-gaap", metricKey: "revenue_usd_m", scale: 1e6, type: "duration" },
  { keys: ["Revenue", "RevenueFromContractsWithCustomers"], taxo: "ifrs-full", metricKey: "revenue_usd_m", scale: 1e6, type: "duration" },
  { keys: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"], taxo: "us-gaap", metricKey: "cost_of_revenue_usd_m", scale: 1e6, type: "duration" },
  { keys: ["CostOfSales"], taxo: "ifrs-full", metricKey: "cost_of_revenue_usd_m", scale: 1e6, type: "duration" },
  { keys: ["GrossProfit"], taxo: "us-gaap", metricKey: "gross_profit_usd_m", scale: 1e6, type: "duration" },
  { keys: ["GrossProfit"], taxo: "ifrs-full", metricKey: "gross_profit_usd_m", scale: 1e6, type: "duration" },
  { keys: ["OperatingIncomeLoss"], taxo: "us-gaap", metricKey: "operating_income_usd_m", scale: 1e6, type: "duration" },
  { keys: ["ProfitLossFromOperatingActivities"], taxo: "ifrs-full", metricKey: "operating_income_usd_m", scale: 1e6, type: "duration" },
  { keys: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", "IncomeLossBeforeIncomeTaxes"], taxo: "us-gaap", metricKey: "pretax_income_usd_m", scale: 1e6, type: "duration" },
  { keys: ["ProfitLossBeforeTax"], taxo: "ifrs-full", metricKey: "pretax_income_usd_m", scale: 1e6, type: "duration" },
  { keys: ["NetIncomeLoss"], taxo: "us-gaap", metricKey: "net_income_usd_m", scale: 1e6, type: "duration" },
  { keys: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"], taxo: "ifrs-full", metricKey: "net_income_usd_m", scale: 1e6, type: "duration" },
  { keys: ["EarningsPerShareBasic"], taxo: "us-gaap", metricKey: "eps_usd", scale: 1, type: "duration" },
  { keys: ["BasicEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_usd", scale: 1, type: "duration" },
  { keys: ["EarningsPerShareDiluted"], taxo: "us-gaap", metricKey: "eps_diluted_usd", scale: 1, type: "duration" },
  { keys: ["DilutedEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_diluted_usd", scale: 1, type: "duration" },
  { keys: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], taxo: "us-gaap", metricKey: "operating_cash_flow_usd_m", scale: 1e6, type: "duration" },
  { keys: ["CashFlowsFromUsedInOperatingActivities"], taxo: "ifrs-full", metricKey: "operating_cash_flow_usd_m", scale: 1e6, type: "duration" },
  { keys: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], taxo: "us-gaap", metricKey: "capex_usd_m", scale: 1e6, type: "duration" },
  { keys: ["PurchaseOfPropertyPlantAndEquipment"], taxo: "ifrs-full", metricKey: "capex_usd_m", scale: 1e6, type: "duration" },
  { keys: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], taxo: "us-gaap", metricKey: "total_cash_usd_m", scale: 1e6, type: "instant" },
  { keys: ["CashAndCashEquivalents"], taxo: "ifrs-full", metricKey: "total_cash_usd_m", scale: 1e6, type: "instant" },
  { keys: ["LongTermDebt", "LongTermDebtNoncurrent"], taxo: "us-gaap", metricKey: "long_term_debt_usd_m", scale: 1e6, type: "instant" },
  { keys: ["NoncurrentBorrowings", "Borrowings"], taxo: "ifrs-full", metricKey: "long_term_debt_usd_m", scale: 1e6, type: "instant" },
  { keys: ["LongTermDebtCurrent", "DebtCurrent", "ShortTermBorrowings"], taxo: "us-gaap", metricKey: "short_term_debt_usd_m", scale: 1e6, type: "instant" },
  { keys: ["CurrentBorrowings"], taxo: "ifrs-full", metricKey: "short_term_debt_usd_m", scale: 1e6, type: "instant" },
  { keys: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], taxo: "us-gaap", metricKey: "shareholders_equity_usd_m", scale: 1e6, type: "instant" },
  { keys: ["EquityAttributableToOwnersOfParent", "Equity"], taxo: "ifrs-full", metricKey: "shareholders_equity_usd_m", scale: 1e6, type: "instant" },
  { keys: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"], taxo: "us-gaap", metricKey: "weighted_diluted_shares_m", scale: 1e6, type: "duration" },
  { keys: ["WeightedAverageDilutedSharesOutstanding", "WeightedAverageBasicSharesOutstanding"], taxo: "ifrs-full", metricKey: "weighted_diluted_shares_m", scale: 1e6, type: "duration" },
];

function padCik(cik) { return String(cik).replace(/^CIK/i, "").padStart(10, "0"); }
function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function isPureQuarter(v) {
  if (!v.start || !v.end) return false;
  const span = (new Date(v.end).getTime() - new Date(v.start).getTime()) / 86_400_000;
  return span >= 80 && span <= 100;
}
function isInstant(v) { return !v.start && !!v.end; }

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return { status: r.status, body: null };
    return { status: 200, body: await r.json() };
  } catch (e) { return { status: 0, body: null, err: e.message }; }
  finally { clearTimeout(t); }
}

// No cross-run cache — SP500∪R1000 tickers are unique, cache would
// never hit, and holding every response in memory (some 30+ MB
// each for Alphabet/Berkshire) OOMs after ~650 CIKs. Fetch per-CIK
// and let GC reclaim after each iteration returns.
async function fetchSecCompanyFacts(cik) {
  const padded = padCik(cik);
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  const { status, body } = await fetchJson(url);
  if (status !== 200 || !body) return null;
  return body.facts ?? {};
}

// Pick the reporting-quarter fact for a spec + event (mirrors
// rederive-sec-xbrl.mjs extractQuarterValues).
function pickSecFact(secFacts, spec, event) {
  if (!event.eventDate) return null;
  const eventMs = new Date(event.eventDate).getTime();
  const taxo = secFacts?.[spec.taxo];
  if (!taxo) return null;
  for (const k of spec.keys) {
    const item = taxo[k];
    if (!item) continue;
    const units = item.units ?? {};
    const unitKey = ["USD", "USD/shares", "shares"].find((u) => units[u]) ?? Object.keys(units)[0];
    if (!unitKey) continue;
    const values = units[unitKey] ?? [];
    const candidates = values.filter((v) => {
      if (!v.filed) return false;
      const ok = spec.type === "instant" ? isInstant(v) : isPureQuarter(v);
      if (!ok) return false;
      // instant: match end to event date within ±14 days
      // duration: match filed to event date within ±3 days
      if (spec.type === "instant") {
        const endDelta = Math.abs(new Date(v.end).getTime() - eventMs) / 86_400_000;
        return endDelta <= 14;
      } else {
        const filedDelta = Math.abs(new Date(v.filed).getTime() - eventMs) / 86_400_000;
        return filedDelta <= 3;
      }
    });
    if (candidates.length === 0) continue;
    // Duration: prefer smallest (filed - end) gap (reporting quarter, not comparative).
    // Instant: prefer latest filed (10-Q/A supersedes 10-Q).
    if (spec.type === "duration") {
      candidates.sort((a, b) => {
        const aGap = new Date(a.filed).getTime() - new Date(a.end).getTime();
        const bGap = new Date(b.filed).getTime() - new Date(b.end).getTime();
        return aGap - bGap;
      });
    } else {
      candidates.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""));
    }
    return { fact: candidates[0], unitKey, xbrlKey: k, taxonomy: spec.taxo };
  }
  return null;
}

async function main() {
  const startedAt = new Date().toISOString();
  const reg = JSON.parse(await fs.readFile(REG, "utf-8"));
  const entities = reg.entities ?? [];

  // Scope filter
  let targets = entities.filter((e) => e.securityType === "operating" && e.edgarCik);
  if (SCOPE === "sp500") targets = targets.filter((e) => (e.index_membership ?? []).includes("SP500"));
  else if (SCOPE === "r1000") targets = targets.filter((e) => (e.index_membership ?? []).includes("R1000"));
  else if (SCOPE === "sp500-r1000") {
    targets = targets.filter((e) => {
      const im = e.index_membership ?? [];
      return im.includes("SP500") || im.includes("R1000");
    });
  }
  if (ONLY_TICKER) targets = targets.filter((e) => e.ticker === ONLY_TICKER);

  console.log(`metrics-reality-check · ${startedAt}`);
  console.log(`  scope: ${SCOPE} · tickers: ${targets.length}`);
  console.log(`  concepts probed per CIK: ${XBRL_MAP.length} (single companyfacts fetch)`);
  console.log(`  delta flag threshold: ${DELTA_FLAG_PCT}%`);
  console.log("");

  const capped = LIMIT !== Infinity ? targets.slice(0, LIMIT) : targets;
  const findings = [];
  const totals = {
    tickers_checked: 0,
    tickers_no_facts: 0,
    events_checked: 0,
    metrics_compared: 0,
    metrics_flagged: 0,
    metrics_no_sec_match: 0,
  };

  for (const e of capped) {
    totals.tickers_checked++;
    let shard;
    try {
      shard = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, `${tickerSlug(e.ticker)}.json`), "utf-8"));
    } catch { continue; }
    const events = (Array.isArray(shard) ? shard : shard.events ?? [])
      .filter((ev) => ev.eventDate && ev.period)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""))
      .slice(0, 4); // latest 4 events per ticker
    if (events.length === 0) continue;

    const secFacts = await fetchSecCompanyFacts(e.edgarCik);
    if (!secFacts) { totals.tickers_no_facts++; continue; }

    for (const ev of events) {
      totals.events_checked++;
      // Group specs by metricKey — try each spec, first match wins
      const byMetric = new Map();
      for (const spec of XBRL_MAP) {
        if (byMetric.has(spec.metricKey)) continue;
        const stored = (ev.metrics ?? []).find((m) => m.key === spec.metricKey)?.actual?.value ?? null;
        if (stored == null) continue; // nothing to compare
        const picked = pickSecFact(secFacts, spec, ev);
        if (!picked) { totals.metrics_no_sec_match++; continue; }
        byMetric.set(spec.metricKey, { spec, picked, stored });
      }
      for (const [metricKey, { spec, picked, stored }] of byMetric) {
        totals.metrics_compared++;
        const secValue = picked.fact.val / spec.scale;
        const denom = Math.max(Math.abs(secValue), 1e-9);
        const deltaPct = ((stored - secValue) / denom) * 100;
        if (Math.abs(deltaPct) > DELTA_FLAG_PCT) {
          totals.metrics_flagged++;
          findings.push({
            ticker: e.ticker,
            cik: padCik(e.edgarCik),
            period: ev.period,
            eventDate: ev.eventDate,
            metric: metricKey,
            storedValue: stored,
            secValue: Number(secValue.toFixed(4)),
            deltaPct: Number(deltaPct.toFixed(1)),
            storedProvenance: (ev.metrics ?? []).find((m) => m.key === metricKey)?.actual?.source?.label ?? null,
            secConcept: `${picked.taxonomy}:${picked.xbrlKey}`,
            secFiled: picked.fact.filed,
            secForm: picked.fact.form,
          });
        }
      }
    }
    if (totals.tickers_checked % 50 === 0) {
      const pct = ((totals.tickers_checked / capped.length) * 100).toFixed(0);
      console.log(`  ${totals.tickers_checked}/${capped.length} (${pct}%) · metrics flagged so far: ${totals.metrics_flagged}`);
    }
  }

  findings.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  // Group by metric for a summary tally
  const byMetric = {};
  for (const f of findings) byMetric[f.metric] = (byMetric[f.metric] || 0) + 1;

  const out = {
    schema: "metrics-reality-check/v1",
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    scope: SCOPE,
    delta_flag_pct_threshold: DELTA_FLAG_PCT,
    totals,
    flagged_by_metric: byMetric,
    worst_offenders_top_30: findings.slice(0, 30),
    findings,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));

  console.log(`\n=== done ===`);
  console.log(`  tickers checked:       ${totals.tickers_checked}`);
  console.log(`  no SEC facts:          ${totals.tickers_no_facts}`);
  console.log(`  events checked:        ${totals.events_checked}`);
  console.log(`  metrics compared:      ${totals.metrics_compared}`);
  console.log(`  metrics no SEC match:  ${totals.metrics_no_sec_match}`);
  console.log(`  metrics flagged (>${DELTA_FLAG_PCT}%): ${totals.metrics_flagged}`);
  console.log(`  wrote → ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`\n  flagged by metric:`);
  for (const [k, v] of Object.entries(byMetric).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(30)} ${v}`);
  if (findings.length > 0) {
    console.log(`\n  top 5 worst deltas:`);
    for (const f of findings.slice(0, 5)) {
      console.log(`    ${f.ticker.padEnd(12)} ${f.period.padEnd(10)} ${f.metric.padEnd(28)} stored=${f.storedValue} sec=${f.secValue} Δ=${f.deltaPct}%`);
    }
  }
}
main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
