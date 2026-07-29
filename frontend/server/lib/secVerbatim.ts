// SEC-verbatim reconciliation.
//
// Rule (established by scripts/rederive-sec-xbrl.mjs): for any listing
// of a company where ANY sibling has an edgarCik, financial metrics
// come from SEC XBRL VERBATIM — per-company fetch, actual unitKey from
// the response (not a hardcoded USD), latest-filed wins, distributed
// to every listing of the company. Yahoo / FMP values on those events
// are superseded at ingest, never stored as primary.
//
// Wired into /api/cron/daily as a reconciliation step after the
// Yahoo/FMP/SEC-submissions passes: newly-created + newly-mutated
// events on CIK'd companies get corrected before the mutateEarnings
// commit. Corollary: the "per-provenance-exclusion" class of bug that
// let NOV GR, TTE, and WELL drift can never resurface because SEC
// verbatim runs regardless of the event's provenance.

import type { EventRecord, MetricEntry } from "@/lib/types";

// Same XBRL_MAP as scripts/backfill-sec-events.mjs + scripts/rederive-sec-xbrl.mjs.
// Kept in sync manually. Order matters: higher-priority spec (us-gaap
// first for a given metric key) wins when both taxonomies have the
// same measure.
// Full XBRL concept priority list per metric. Order within each spec's
// `keys` array is the priority order — first hit wins for that spec.
// Two entries for the same metricKey mean fallback across taxonomies
// (us-gaap first, then ifrs-full). Additions from Task 2 (Sweep 3 +
// Part 4 metric expansion): cost of revenue, pretax income, cash flow
// (OCF + capex), balance sheet snapshot (cash / debt / equity), and
// weighted diluted shares. EBITDA intentionally omitted — SEC XBRL
// rarely reports it directly; prompt rules say "never invented, never
// derived-and-presented-as-reported".
// XBRL specs carry a `type`: `duration` facts have a start+end and
// pass through the 80–100-day pure-quarter filter (income/cashflow
// statements). `instant` facts have only an `end` (point-in-time
// balance-sheet snapshots — cash, debt, equity, shares outstanding);
// they match on end-date ≈ period-end (±7d), latest-filed wins.
// Duration + instant sharing one filter is the bug that kept
// total_cash/total_debt/shareholders_equity at 0% coverage — the
// pure-quarter filter rejected every instant fact for want of a start.
export const XBRL_MAP: Array<{
  keys: string[];
  taxo: string;
  metricKey: string;
  defaultUnit: string;
  scale: number;
  type: "duration" | "instant";
}> = [
  // ─── Income statement (duration facts) ─────────────────────────────
  { keys: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"], taxo: "us-gaap", metricKey: "revenue_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["Revenue", "RevenueFromContractsWithCustomers"], taxo: "ifrs-full", metricKey: "revenue_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"], taxo: "us-gaap", metricKey: "cost_of_revenue_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["CostOfSales"], taxo: "ifrs-full", metricKey: "cost_of_revenue_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["GrossProfit"], taxo: "us-gaap", metricKey: "gross_profit_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["GrossProfit"], taxo: "ifrs-full", metricKey: "gross_profit_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["OperatingIncomeLoss"], taxo: "us-gaap", metricKey: "operating_income_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["ProfitLossFromOperatingActivities"], taxo: "ifrs-full", metricKey: "operating_income_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", "IncomeLossBeforeIncomeTaxes"], taxo: "us-gaap", metricKey: "pretax_income_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["ProfitLossBeforeTax"], taxo: "ifrs-full", metricKey: "pretax_income_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["NetIncomeLoss"], taxo: "us-gaap", metricKey: "net_income_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"], taxo: "ifrs-full", metricKey: "net_income_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["EarningsPerShareBasic"], taxo: "us-gaap", metricKey: "eps_usd", defaultUnit: "USD", scale: 1, type: "duration" },
  { keys: ["BasicEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_usd", defaultUnit: "USD", scale: 1, type: "duration" },
  { keys: ["EarningsPerShareDiluted"], taxo: "us-gaap", metricKey: "eps_diluted_usd", defaultUnit: "USD", scale: 1, type: "duration" },
  { keys: ["DilutedEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_diluted_usd", defaultUnit: "USD", scale: 1, type: "duration" },
  // ─── Cash flow (duration facts) ────────────────────────────────────
  { keys: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], taxo: "us-gaap", metricKey: "operating_cash_flow_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["CashFlowsFromUsedInOperatingActivities"], taxo: "ifrs-full", metricKey: "operating_cash_flow_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], taxo: "us-gaap", metricKey: "capex_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  { keys: ["PurchaseOfPropertyPlantAndEquipment"], taxo: "ifrs-full", metricKey: "capex_usd_m", defaultUnit: "USD", scale: 1e6, type: "duration" },
  // ─── Balance sheet (INSTANT facts) ─────────────────────────────────
  // Cash: prefer excludes-restricted; ShortTermInvestments is its own line, not folded in.
  { keys: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], taxo: "us-gaap", metricKey: "total_cash_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  { keys: ["CashAndCashEquivalents"], taxo: "ifrs-full", metricKey: "total_cash_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  { keys: ["ShortTermInvestments", "AvailableForSaleSecuritiesCurrent"], taxo: "us-gaap", metricKey: "short_term_investments_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  { keys: ["ShorttermInvestments", "CurrentInvestments"], taxo: "ifrs-full", metricKey: "short_term_investments_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  // Debt: preserve components (long+short) as separate metrics AND supply a
  // rolled-up total_debt_usd_m. Prefer explicit LongTermDebt when SEC reports
  // it as a single line; fall back to LongTermDebtNoncurrent when only that
  // exists. DebtCurrent + ShortTermBorrowings are stored under
  // short_term_debt_usd_m. `derived-total-debt` recipe lives in the UI
  // (metricGroups.ts marks derived); we never silently sum on the server.
  { keys: ["LongTermDebt", "LongTermDebtNoncurrent"], taxo: "us-gaap", metricKey: "long_term_debt_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  { keys: ["NoncurrentBorrowings", "Borrowings"], taxo: "ifrs-full", metricKey: "long_term_debt_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  { keys: ["LongTermDebtCurrent", "DebtCurrent", "ShortTermBorrowings"], taxo: "us-gaap", metricKey: "short_term_debt_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  { keys: ["CurrentBorrowings"], taxo: "ifrs-full", metricKey: "short_term_debt_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  // Equity: prefer parent-only (StockholdersEquity) then including-NCI. The
  // matched xbrlKey is preserved on the fact so downstream readers know
  // the minority-interest basis.
  { keys: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], taxo: "us-gaap", metricKey: "shareholders_equity_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  { keys: ["EquityAttributableToOwnersOfParent", "Equity"], taxo: "ifrs-full", metricKey: "shareholders_equity_usd_m", defaultUnit: "USD", scale: 1e6, type: "instant" },
  // Shares — INSTANT: point-in-time count as-of period end. Weighted-diluted
  // preferred; fall back to weighted-basic and label the difference via
  // xbrlKey on the fact.
  { keys: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"], taxo: "us-gaap", metricKey: "weighted_diluted_shares_m", defaultUnit: "shares", scale: 1e6, type: "duration" },
  { keys: ["WeightedAverageDilutedSharesOutstanding", "WeightedAverageBasicSharesOutstanding"], taxo: "ifrs-full", metricKey: "weighted_diluted_shares_m", defaultUnit: "shares", scale: 1e6, type: "duration" },
];

// Strict pure-quarter filter for DURATION facts (income/cashflow).
// REJECTS entries without a start date (the old permissive filter let
// 180-day H1 sums through) and any span outside 80–100 days.
export function isPureQuarter(v: { start?: string; end?: string }): boolean {
  if (!v.start || !v.end) return false;
  const spanDays =
    (new Date(v.end).getTime() - new Date(v.start).getTime()) / 86_400_000;
  return spanDays >= 80 && spanDays <= 100;
}

// INSTANT facts (balance sheet) have only `end` — no span. Filter here
// is trivially "has end"; the ±7d period-end match happens in
// extractQuarterValues below.
export function isInstant(v: { start?: string; end?: string }): boolean {
  return !v.start && !!v.end;
}

// "FY2026 Q2" → "2026-06-30". Calendar-quarter mapping; fiscal-calendar
// offset issuers use the ±31d tolerance in `extractQuarterValues` to land
// on their actual quarter-end.
export function periodEndFromLabel(label: string | undefined): string | null {
  const m = /FY(\d{4})\s+Q(\d)/i.exec(label ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const monthDay = { 1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31" }[q];
  return monthDay ? `${year}-${monthDay}` : null;
}

interface XbrlValue {
  val: number;
  start?: string;
  end: string;
  filed?: string;
  form?: string;
  accn?: string;
  fp?: string;
  fy?: number;
}
interface XbrlItem {
  units?: Record<string, XbrlValue[]>;
}
export interface SecFacts {
  facts?: Record<string, Record<string, XbrlItem>>;
}

export interface QuarterValue {
  value: number;
  unit: string; // SEC's actual unit key — "USD", "CAD", "DKK", "USD/shares", …
  xbrlKey: string;
  taxonomy: string;
  matched_end: string;
  form?: string;
  accession?: string;
}

// Given SEC facts + a period-end target date, return a Map<metricKey,
// QuarterValue> with SEC's own unit label. Later-filed amendments
// supersede earlier ones on the same period.
export function extractQuarterValues(
  facts: SecFacts["facts"] | undefined,
  periodEnd: string,
): Map<string, QuarterValue> {
  const out = new Map<string, QuarterValue>();
  if (!facts) return out;
  const periodEndMs = new Date(periodEnd).getTime();
  for (const spec of XBRL_MAP) {
    if (out.has(spec.metricKey)) continue;
    const taxo = facts[spec.taxo];
    if (!taxo) continue;
    // Instant tolerance is TIGHTER: balance-sheet snapshots MUST match
    // the period end within a week or the number belongs to a different
    // reporting date. Duration tolerance is ±31d to allow fiscal-calendar
    // offset issuers (Apple, HD) whose Q1 ends 12/31 but files under
    // calendar-Q4 ended 12-day-later actual filings.
    const maxDeltaDays = spec.type === "instant" ? 7 : 31;
    for (const k of spec.keys) {
      const item = taxo[k];
      if (!item) continue;
      const units = item.units ?? {};
      const unitKey =
        ["USD", "USD/shares"].find((u) => units[u]) ?? Object.keys(units)[0];
      if (!unitKey) continue;
      const values = units[unitKey] ?? [];
      let best: XbrlValue | null = null;
      let bestDelta = Infinity;
      let bestFiled = "";
      for (const v of values) {
        // Type-appropriate filter: duration checks span, instant checks
        // absence-of-start. A duration fact that leaks into a spec typed
        // as instant is caught by isInstant returning false, and vice
        // versa — this is the fix for the balance-sheet 0% coverage bug.
        const ok = spec.type === "instant" ? isInstant(v) : isPureQuarter(v);
        if (!ok) continue;
        const d = Math.abs((new Date(v.end).getTime() - periodEndMs) / 86_400_000);
        if (
          d < bestDelta ||
          (d === bestDelta && (v.filed ?? "") > bestFiled)
        ) {
          bestDelta = d;
          best = v;
          bestFiled = v.filed ?? "";
        }
      }
      if (best && bestDelta <= maxDeltaDays) {
        out.set(spec.metricKey, {
          value: best.val / spec.scale,
          unit: unitKey, // ← SEC's actual unit, verbatim (NOT hardcoded)
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

// Rewrite an event's metrics in-place with SEC verbatim values.
// Returns the number of metrics replaced/added (0 means no change).
// Old ours-side values move to `metric.superseded[]` with a
// replaced_by note so the audit trail survives.
//
// Rule from the July-2026 residual work: value match with unit
// mismatch STILL triggers a rewrite (Enbridge stored the right
// number 22357 but labelled USD when SEC has only CAD).
export function applySecVerbatimToEvent(
  ev: EventRecord,
  facts: SecFacts["facts"] | undefined,
  paddedCik: string,
): { touched: boolean; replaced: number; added: number } {
  const anchor =
    periodEndFromLabel(ev.period) ?? ev.eventDate ?? ev.scheduledDate;
  if (!anchor) return { touched: false, replaced: 0, added: 0 };
  const rederivedValues = extractQuarterValues(facts, anchor);
  if (rederivedValues.size === 0) return { touched: false, replaced: 0, added: 0 };
  const now = new Date().toISOString();
  let replaced = 0;
  let added = 0;
  for (const [metricKey, freshFact] of rederivedValues) {
    const existing = (ev.metrics ?? []).find((m) => m.key === metricKey) as
      | (MetricEntry & { superseded?: unknown[] })
      | undefined;
    const accessionNoDashes = (freshFact.accession ?? "").replace(/-/g, "");
    const filingUrl = accessionNoDashes
      ? `https://www.sec.gov/Archives/edgar/data/${Number(paddedCik)}/${accessionNoDashes}/`
      : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(freshFact.form ?? "")}`;
    const newActual = {
      value: freshFact.value,
      unit: freshFact.unit,
      source: {
        url: filingUrl,
        label: `SEC EDGAR · ${freshFact.form ?? "?"} · ${freshFact.xbrlKey}`,
        provenance: "regulatory" as const,
        locator: null,
      },
      asOf: freshFact.matched_end,
      fetchedAt: now,
      method: "filing_manual" as const,
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
      added++;
      continue;
    }
    const oldVal = existing.actual?.value ?? null;
    const oldUnit = existing.actual?.unit ?? null;
    const denom = Math.max(Math.abs(freshFact.value), 1e-9);
    const pctDelta =
      oldVal != null ? ((oldVal - freshFact.value) / denom) * 100 : null;
    // "Unchanged" ONLY when both value AND unit match. See Enbridge
    // note above.
    if (
      oldVal != null &&
      pctDelta != null &&
      Math.abs(pctDelta) < 0.5 &&
      oldUnit === freshFact.unit
    ) {
      continue;
    }
    if (existing.actual && oldVal != null) {
      if (!Array.isArray(existing.superseded)) existing.superseded = [];
      existing.superseded.push({
        value: oldVal,
        unit: existing.actual.unit,
        source: existing.actual.source?.label ?? null,
        asOf: existing.actual.asOf ?? null,
        fetchedAt: existing.actual.fetchedAt ?? null,
        replaced_at: now,
        replaced_by: "cron-sec-verbatim",
        pct_delta: pctDelta,
      });
    }
    existing.actual = newActual;
    replaced++;
  }
  return { touched: replaced + added > 0, replaced, added };
}

// SEC fair-access wrapper: 1 req/sec bucket + per-CIK response cache.
// Returned promise settles to null on any fetch failure — callers must
// treat null as "SEC unavailable, keep the ours-side value".
export interface SecFactsCache {
  fetch(cik: string): Promise<SecFacts["facts"] | null>;
}

export function makeSecFactsCache(
  ua = "Earnings Tracker (contact@example.com)",
  intervalMs = 1000,
): SecFactsCache {
  const cache = new Map<string, SecFacts["facts"] | null>();
  let next = 0;
  return {
    async fetch(cik: string) {
      const padded = String(cik).padStart(10, "0");
      if (cache.has(padded)) return cache.get(padded) ?? null;
      const now = Date.now();
      const t = Math.max(now, next);
      next = t + intervalMs;
      if (t > now) await new Promise((r) => setTimeout(r, t - now));
      try {
        const r = await fetch(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
          {
            headers: { "User-Agent": ua, Accept: "application/json" },
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!r.ok) {
          cache.set(padded, null);
          return null;
        }
        const j = (await r.json()) as SecFacts;
        cache.set(padded, j.facts ?? null);
        return j.facts ?? null;
      } catch {
        cache.set(padded, null);
        return null;
      }
    },
  };
}
