#!/usr/bin/env node
/**
 * Re-derive every event with provenance `sec-xbrl-companyfacts` from a
 * single freshly-fetched SEC XBRL companyfacts response per companyId.
 * Corrects the two root causes surfaced by scripts/verify-financials.mjs:
 *
 *   (1) `isPureQuarter` in the old backfill was permissive — entries
 *       missing `start` slipped through and produced 180-day-span values
 *       (H1 sums) labelled as quarterly. Fix: REJECT entries without
 *       start; enforce span in [80, 100] days strictly.
 *
 *   (2) Old backfill fetched SEC per LISTING, so multi-listed companies
 *       (Alphabet has 17 shard tickers) captured different snapshots at
 *       different times → four different Q2 2026 revenue values for the
 *       same underlying company. Fix: fetch once per companyId (using the
 *       canonical entity's CIK), distribute values to every listing shard.
 *
 * Old values move to the metric's `superseded[]` array with the
 * rederivation source labelled — no silent overwrites.
 *
 *   node scripts/rederive-sec-xbrl.mjs           # write
 *   node scripts/rederive-sec-xbrl.mjs --dry     # report only
 *   node scripts/rederive-sec-xbrl.mjs --limit=10   # small probe
 *
 * Rate-limited to 1 req/sec against data.sec.gov. Re-derives revenue +
 * gross profit + operating income + net income + basic EPS + diluted
 * EPS — the same XBRL_MAP as backfill-sec-events.mjs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");
const OUT = path.join(OUT_DIR, "rederive-sec-xbrl.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : Infinity;
const REQ_INTERVAL_MS = 1000;

const SEC_UA = "Earnings Tracker (contact@example.com)";

// XBRL concept priority list — expanded for Task 2 (Sweep 3 + Part 4).
// Kept in sync with frontend/server/lib/secVerbatim.ts XBRL_MAP.
// `type: "instant"` marks balance-sheet snapshots (cash/debt/equity/shares
// outstanding); they carry only an `end`, not a span. `type: "duration"`
// is the standard income-statement / cashflow shape (start+end, 80–100d
// span). Splitting these was the fix for the balance-sheet-coverage 0%.
const XBRL_MAP = [
  { keys: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"], taxo: "us-gaap", metricKey: "revenue_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["Revenue", "RevenueFromContractsWithCustomers"], taxo: "ifrs-full", metricKey: "revenue_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"], taxo: "us-gaap", metricKey: "cost_of_revenue_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["CostOfSales"], taxo: "ifrs-full", metricKey: "cost_of_revenue_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["GrossProfit"], taxo: "us-gaap", metricKey: "gross_profit_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["GrossProfit"], taxo: "ifrs-full", metricKey: "gross_profit_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["OperatingIncomeLoss"], taxo: "us-gaap", metricKey: "operating_income_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["ProfitLossFromOperatingActivities"], taxo: "ifrs-full", metricKey: "operating_income_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", "IncomeLossBeforeIncomeTaxes"], taxo: "us-gaap", metricKey: "pretax_income_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["ProfitLossBeforeTax"], taxo: "ifrs-full", metricKey: "pretax_income_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["NetIncomeLoss"], taxo: "us-gaap", metricKey: "net_income_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"], taxo: "ifrs-full", metricKey: "net_income_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["EarningsPerShareBasic"], taxo: "us-gaap", metricKey: "eps_usd", unit: "USD", scale: 1, type: "duration" },
  { keys: ["BasicEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_usd", unit: "USD", scale: 1, type: "duration" },
  { keys: ["EarningsPerShareDiluted"], taxo: "us-gaap", metricKey: "eps_diluted_usd", unit: "USD", scale: 1, type: "duration" },
  { keys: ["DilutedEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_diluted_usd", unit: "USD", scale: 1, type: "duration" },
  { keys: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], taxo: "us-gaap", metricKey: "operating_cash_flow_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["CashFlowsFromUsedInOperatingActivities"], taxo: "ifrs-full", metricKey: "operating_cash_flow_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], taxo: "us-gaap", metricKey: "capex_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  { keys: ["PurchaseOfPropertyPlantAndEquipment"], taxo: "ifrs-full", metricKey: "capex_usd_m", unit: "USD", scale: 1e6, type: "duration" },
  // ─── Balance sheet (INSTANT) ─────────────────────────────────────
  { keys: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], taxo: "us-gaap", metricKey: "total_cash_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["CashAndCashEquivalents"], taxo: "ifrs-full", metricKey: "total_cash_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["ShortTermInvestments", "AvailableForSaleSecuritiesCurrent"], taxo: "us-gaap", metricKey: "short_term_investments_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["ShorttermInvestments", "CurrentInvestments"], taxo: "ifrs-full", metricKey: "short_term_investments_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["LongTermDebt", "LongTermDebtNoncurrent"], taxo: "us-gaap", metricKey: "long_term_debt_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["NoncurrentBorrowings", "Borrowings"], taxo: "ifrs-full", metricKey: "long_term_debt_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["LongTermDebtCurrent", "DebtCurrent", "ShortTermBorrowings"], taxo: "us-gaap", metricKey: "short_term_debt_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["CurrentBorrowings"], taxo: "ifrs-full", metricKey: "short_term_debt_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], taxo: "us-gaap", metricKey: "shareholders_equity_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["EquityAttributableToOwnersOfParent", "Equity"], taxo: "ifrs-full", metricKey: "shareholders_equity_usd_m", unit: "USD", scale: 1e6, type: "instant" },
  { keys: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"], taxo: "us-gaap", metricKey: "weighted_diluted_shares_m", unit: "shares", scale: 1e6, type: "duration" },
  { keys: ["WeightedAverageDilutedSharesOutstanding", "WeightedAverageBasicSharesOutstanding"], taxo: "ifrs-full", metricKey: "weighted_diluted_shares_m", unit: "shares", scale: 1e6, type: "duration" },
];

// "FY2026 Q2" → "2026-06-30" (calendar quarter end). Fiscal-calendar
// offset issuers (Apple, HD, etc.) file with a different quarter-end
// than the calendar month; the extractQuarterValues ±31-day window
// tolerates that.
function periodEndFromLabel(label) {
  const m = /FY(\d{4})\s+Q(\d)/i.exec(label ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const monthDay = { 1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31" }[q];
  return monthDay ? `${year}-${monthDay}` : null;
}

// STRICT quarter filter — the fix for root cause (1).
// Old logic:
//   if (v.start) { … span check … } // ← entries without start slipped through
// New logic:
//   Reject if start is missing; span MUST be 80–100 days.
function isPureQuarter(v) {
  if (!v.start || !v.end) return false;
  const start = new Date(v.start).getTime();
  const end = new Date(v.end).getTime();
  const spanDays = (end - start) / 86_400_000;
  return spanDays >= 80 && spanDays <= 100;
}
function isInstant(v) {
  return !v.start && !!v.end;
}

class RateLimiter {
  constructor(intervalMs) { this.intervalMs = intervalMs; this.next = 0; }
  async wait() {
    const now = Date.now();
    const t = Math.max(now, this.next);
    this.next = t + this.intervalMs;
    if (t > now) await new Promise((r) => setTimeout(r, t - now));
  }
}

async function fetchCompanyFacts(cik, limiter, cache) {
  const padded = String(cik).padStart(10, "0");
  if (cache.has(padded)) return cache.get(padded);
  await limiter.wait();
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) { cache.set(padded, { throttled: true }); return cache.get(padded); }
    if (!r.ok) { cache.set(padded, { error: `HTTP ${r.status}` }); return cache.get(padded); }
    const j = await r.json();
    cache.set(padded, { ok: true, facts: j.facts ?? {} });
    return cache.get(padded);
  } catch (e) {
    cache.set(padded, { error: e.message ?? "network" });
    return cache.get(padded);
  }
}

// Given SEC facts + period-end target, find the strict-quarter value for
// each XBRL_MAP metric family. Returns a Map<metricKey, {value, unit, source}>.
function extractQuarterValues(facts, periodEnd) {
  const out = new Map();
  const periodEndMs = new Date(periodEnd).getTime();
  for (const spec of XBRL_MAP) {
    if (out.has(spec.metricKey)) continue; // higher-priority spec already won
    const taxo = facts?.[spec.taxo];
    if (!taxo) continue;
    const maxDeltaDays = spec.type === "instant" ? 7 : 31;
    for (const k of spec.keys) {
      const item = taxo[k];
      if (!item) continue;
      const units = item.units ?? {};
      const unitKey = ["USD", "USD/shares"].find((u) => units[u]) ?? Object.keys(units)[0];
      if (!unitKey) continue;
      const values = units[unitKey] ?? [];
      let best = null;
      let bestDelta = Infinity;
      let bestFiled = "";
      for (const v of values) {
        const ok = spec.type === "instant" ? isInstant(v) : isPureQuarter(v);
        if (!ok) continue;
        const d = Math.abs((new Date(v.end).getTime() - periodEndMs) / 86_400_000);
        // Prefer closer period-end match; on ties, prefer LATER filing
        // date (10-Q/A amendments supersede the original 10-Q).
        if (d < bestDelta || (d === bestDelta && (v.filed ?? "") > bestFiled)) {
          bestDelta = d;
          best = v;
          bestFiled = v.filed ?? "";
        }
      }
      if (best && bestDelta <= maxDeltaDays) {
        // Inherit SEC's actual reported unit — never assume USD. The
        // XBRL_MAP's `spec.unit` is only the DEFAULT (used when SEC
        // has USD available); foreign filers like Enbridge report only
        // in CAD under us-gaap:Revenues, and Novo Nordisk only in DKK
        // via ifrs-full — those unit labels must survive intact so the
        // cross-listing invariant compares apples-to-apples.
        out.set(spec.metricKey, {
          value: best.val / spec.scale,
          unit: unitKey,
          xbrlKey: k,
          taxonomy: spec.taxo,
          matched_end: best.end,
          form: best.form,
          accession: best.accn,
        });
        break;
      }
    }
  }
  return out;
}

async function main() {
  console.log(`rederive-sec-xbrl · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const entityByTicker = new Map(reg.entities.map((e) => [e.ticker, e]));

  // Group ALL past events by companyId when the company has a CIK.
  // Broadening beyond `sec-xbrl-companyfacts` provenance closes the
  // three residual anomalies from the July-2026 audit follow-up:
  //   - NOV GR (Novo Nordisk) had one listing with a wrong-scale USD
  //     value from a non-SEC source while four DKK siblings agreed —
  //     re-derive from SEC pulls that listing back to the same value.
  //   - TTE (TotalEnergies) had cluster split (44,676 vs 49,627) across
  //     listings that were originally ingested from yahoo-timeseries at
  //     different snapshots — SEC verbatim collapses the clusters.
  //   - WELL (Welltower) had 1.3% FX round-trip drift between US and MM
  //     listings — SEC verbatim on both listings kills the round-trip.
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const eventsByCompany = new Map();
  let totalEligible = 0;
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const wrapped = !Array.isArray(j);
    const evs = wrapped ? (j.events ?? []) : j;
    for (const ev of evs) {
      if (!ev.eventDate) continue;
      const entity = entityByTicker.get(ev.ticker);
      // Only companies with a CIK — SEC XBRL is only available for
      // SEC filers. Foreign-only companies (no CIK) are untouched.
      const cikOnMember =
        entity?.edgarCik ?? null;
      // Even a listing without its OWN CIK is eligible if a SIBLING in
      // its company group has one — the whole point of the fix is that
      // ALL listings inherit the same SEC value.
      const cid = entity?.companyId;
      if (!cid) continue;
      totalEligible++;
      if (!eventsByCompany.has(cid)) eventsByCompany.set(cid, { events: [], shards: new Map() });
      const co = eventsByCompany.get(cid);
      co.events.push(ev);
      if (!co.shards.has(p)) co.shards.set(p, { wrapped, body: j, events: evs });
    }
  }
  // Prune companies that have zero CIK across all their members —
  // SEC can't verify those. Also prune the un-cik'd members' events
  // from CIK'd companies IF the company has zero events on the SEC
  // filer's own listings (rare).
  for (const [cid, co] of eventsByCompany) {
    const members = co.events.map((ev) => entityByTicker.get(ev.ticker)).filter(Boolean);
    if (!members.some((m) => m?.edgarCik)) {
      eventsByCompany.delete(cid);
      totalEligible -= co.events.length;
    }
  }
  console.log(`eligible events (companies with a CIK on any listing): ${totalEligible} across ${eventsByCompany.size} companies`);

  const limiter = new RateLimiter(REQ_INTERVAL_MS);
  const cache = new Map();
  let processed = 0;
  const stats = {
    events_touched: 0,
    metrics_replaced: 0,
    metrics_added: 0,
    metrics_unchanged: 0,
    events_no_cik: 0,
    events_no_facts: 0,
    events_no_match: 0,
  };
  const shardsToWrite = new Set();
  const perCompanyDelta = [];

  outer: for (const [companyId, co] of eventsByCompany) {
    if (processed >= LIMIT) break;
    processed++;
    // Pick the CIK from the canonical listing preferentially; else any
    // member with a CIK. Same-company members should share a CIK, so
    // "any" is fine.
    const members = co.events.map((ev) => entityByTicker.get(ev.ticker)).filter(Boolean);
    const canonical = members.find((e) => e.isCanonical);
    let cik =
      canonical?.edgarCik ?? members.find((e) => e.edgarCik)?.edgarCik ?? null;
    if (!cik) {
      stats.events_no_cik += co.events.length;
      continue;
    }
    const cikState = await fetchCompanyFacts(cik, limiter, cache);
    if (!cikState.ok) {
      stats.events_no_facts += co.events.length;
      continue;
    }
    let anyChange = false;
    const beforeAfterSamples = [];
    for (const ev of co.events) {
      // Derive period-end from the event's period label — "FY2026 Q2"
      // → 2026-06-30. This is the CORRECT anchor for SEC XBRL matching.
      // Do NOT use metric.actual.asOf: prior backfill runs stamped that
      // with the fetchedAt timestamp (today), so it mis-anchors every
      // historical event onto today's date and my earlier dry-run
      // picked the same nearest-SEC-entry for every historical quarter.
      const anchor = periodEndFromLabel(ev.period) ?? ev.eventDate ?? ev.scheduledDate;
      if (!anchor) continue;
      const rederivedValues = extractQuarterValues(cikState.facts, anchor);
      if (rederivedValues.size === 0) {
        stats.events_no_match++;
        continue;
      }
      let touched = false;
      for (const [metricKey, freshFact] of rederivedValues) {
        const existing = (ev.metrics ?? []).find((m) => m.key === metricKey);
        const paddedCik = String(cik).padStart(10, "0");
        const accessionNoDashes = (freshFact.accession ?? "").replace(/-/g, "");
        const filingUrl = accessionNoDashes
          ? `https://www.sec.gov/Archives/edgar/data/${Number(paddedCik)}/${accessionNoDashes}/`
          : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(freshFact.form ?? "")}`;
        const now = new Date().toISOString();
        const newActual = {
          value: freshFact.value,
          unit: freshFact.unit,
          source: {
            url: filingUrl,
            label: `SEC EDGAR · ${freshFact.form ?? "?"} · ${freshFact.xbrlKey}`,
            provenance: "regulatory",
            locator: null,
          },
          asOf: freshFact.matched_end,
          fetchedAt: now,
          method: "filing_manual",
          confidence: 0.98,
        };
        if (!existing) {
          if (!Array.isArray(ev.metrics)) ev.metrics = [];
          ev.metrics.push({
            key: metricKey,
            displayLabel: metricKey.replace(/_usd_m$/, " (M)").replace(/_/g, " "),
            isHeadline: false,
            surprisePct: null,
            estimate: null,
            actual: newActual,
            prior: null,
          });
          stats.metrics_added++;
          touched = true;
          continue;
        }
        const oldVal = existing.actual?.value;
        const oldUnit = existing.actual?.unit;
        const denom = Math.max(Math.abs(freshFact.value), 1e-9);
        const pctDelta =
          oldVal != null ? ((oldVal - freshFact.value) / denom) * 100 : null;
        // "Unchanged" ONLY when both value and unit match. A value match
        // with a unit mismatch (Enbridge stored USD when SEC has CAD)
        // still needs a rewrite so the cross-listing invariant compares
        // apples-to-apples.
        if (oldVal != null && Math.abs(pctDelta) < 0.5 && oldUnit === freshFact.unit) {
          stats.metrics_unchanged++;
          continue;
        }
        // Replace — move old to superseded[].
        if (existing.actual && oldVal != null) {
          if (!Array.isArray(existing.superseded)) existing.superseded = [];
          existing.superseded.push({
            value: oldVal,
            unit: existing.actual.unit,
            source: existing.actual.source?.label ?? null,
            asOf: existing.actual.asOf ?? null,
            fetchedAt: existing.actual.fetchedAt ?? null,
            replaced_at: now,
            replaced_by: "rederive-sec-xbrl",
            pct_delta: pctDelta,
          });
        }
        existing.actual = newActual;
        stats.metrics_replaced++;
        touched = true;
        if (beforeAfterSamples.length < 3 && metricKey === "revenue_usd_m") {
          beforeAfterSamples.push({
            ticker: ev.ticker,
            period: ev.period,
            old: oldVal,
            new: freshFact.value,
            pct: pctDelta,
          });
        }
      }
      if (touched) {
        stats.events_touched++;
        anyChange = true;
        ev.provenanceAsOf = new Date().toISOString();
      }
    }
    if (anyChange) {
      perCompanyDelta.push({ companyId, listings: co.events.length, samples: beforeAfterSamples });
      for (const p of co.shards.keys()) shardsToWrite.add(p);
    }
    if (processed % 20 === 0) {
      console.log(
        `  processed ${processed}/${eventsByCompany.size} companies · touched=${stats.events_touched} · replaced=${stats.metrics_replaced} · shards=${shardsToWrite.size}`,
      );
    }
  }

  console.log(`\n=== Re-derivation stats ===`);
  console.log(`Events touched:          ${stats.events_touched}`);
  console.log(`Metrics replaced:        ${stats.metrics_replaced}`);
  console.log(`Metrics added:           ${stats.metrics_added}`);
  console.log(`Metrics unchanged (<0.5%): ${stats.metrics_unchanged}`);
  console.log(`Events skipped — no CIK:   ${stats.events_no_cik}`);
  console.log(`Events skipped — no facts: ${stats.events_no_facts}`);
  console.log(`Events skipped — no match: ${stats.events_no_match}`);
  console.log(`Shards to write:         ${shardsToWrite.size}`);

  if (perCompanyDelta.length > 0) {
    console.log(`\n=== Sample corrections ===`);
    for (const co of perCompanyDelta.slice(0, 5)) {
      console.log(`company=${co.companyId} listings=${co.listings}`);
      for (const s of co.samples) {
        console.log(
          `  ${s.ticker.padEnd(14)} ${s.period}  old=${s.old?.toFixed(1) ?? "-"}M  →  new=${s.new.toFixed(1)}M  Δ=${s.pct?.toFixed(2) ?? "-"}%`,
        );
      }
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        schema: "rederive-sec-xbrl/v1",
        generatedAt: new Date().toISOString(),
        stats,
        per_company_delta: perCompanyDelta,
      },
      null,
      2,
    ),
  );

  if (DRY) {
    console.log(`\nDry run — no shard writes. Audit at ${OUT}.`);
    return;
  }
  for (const [companyId, co] of eventsByCompany) {
    for (const [p, ctx] of co.shards) {
      if (!shardsToWrite.has(p)) continue;
      const body = ctx.wrapped ? { ...ctx.body, events: ctx.events } : ctx.events;
      await fs.writeFile(p, JSON.stringify(body, null, 2));
    }
  }
  console.log(`\n✓ updated ${shardsToWrite.size} shards`);
}

main().catch((e) => { console.error(e); process.exit(1); });
