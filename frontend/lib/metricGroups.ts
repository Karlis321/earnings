// Metric grouping helper — categorizes metric keys into 4 panels
// (Income statement / Cash flow / Balance sheet / Derived) with a
// fallback "Other" bucket for keys not in the canonical mapping.
//
// Policy: a "derived" fact (Fact.derived === true) or a margin/FCF key
// is routed ONLY to the Derived panel, never duplicated into its
// natural panel — that keeps the reported-vs-computed split visually
// obvious and avoids the same figure appearing twice on one page.

export type MetricGroup =
  | "income"
  | "cashflow"
  | "balance"
  | "derived"
  | "other";

const INCOME_KEYS = new Set<string>([
  "revenue_usd_m",
  "cost_of_revenue_usd_m",
  "gross_profit_usd_m",
  "operating_income_usd_m",
  "ebit_usd_m",
  "ebitda_usd_m",
  "pretax_income_usd_m",
  "net_income_usd_m",
  "eps_usd",
  "eps_diluted_usd",
]);

const CASHFLOW_KEYS = new Set<string>([
  "operating_cash_flow_usd_m",
  "capex_usd_m",
  // fcf is derived — see DERIVED_KEYS below, it routes to Derived panel
]);

const BALANCE_KEYS = new Set<string>([
  "total_cash_usd_m",
  "total_debt_usd_m",
  "shareholders_equity_usd_m",
  "weighted_diluted_shares_m",
]);

// Keys that are always derived (margins + FCF) — routed to Derived panel
// regardless of the Fact.derived flag.
const DERIVED_KEYS = new Set<string>([
  "gross_margin_pct",
  "operating_margin_pct",
  "net_margin_pct",
  "fcf_usd_m",
]);

export function isDerivedMetric(metricKey: string, isDerived: boolean): boolean {
  return isDerived || DERIVED_KEYS.has(metricKey);
}

export function groupOf(metricKey: string, isDerived: boolean): MetricGroup {
  if (isDerivedMetric(metricKey, isDerived)) return "derived";
  if (INCOME_KEYS.has(metricKey)) return "income";
  if (CASHFLOW_KEYS.has(metricKey)) return "cashflow";
  if (BALANCE_KEYS.has(metricKey)) return "balance";
  return "other";
}

export function metricGroupLabel(g: MetricGroup): string {
  switch (g) {
    case "income":
      return "Income statement";
    case "cashflow":
      return "Cash flow";
    case "balance":
      return "Balance sheet";
    case "derived":
      return "Derived";
    case "other":
      return "Other";
  }
}

// Canonical panel order — Derived + Other come last.
export const METRIC_GROUP_ORDER: MetricGroup[] = [
  "income",
  "cashflow",
  "balance",
  "derived",
  "other",
];
