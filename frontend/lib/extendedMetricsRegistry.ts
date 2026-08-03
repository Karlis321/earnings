// Extended metrics registry — the per-sector set of non-standard
// line items Claude extracts from 10-Q / 8-K / EX-99 filings.
// Populated by /earnings step 3b; stored on event.extendedMetrics[].
//
// Design principles:
//   - Every metric names an EXACT unit convention so peers compare
//     apples-to-apples (comp sales as %, RASM as ¢/mile, NIM as %).
//   - Claude only writes a value when it can cite an exact quote
//     from the filing; low-confidence prose extractions are dropped.
//   - Universal set applies to EVERY ticker regardless of sector;
//     sector-specific set is layered on top by sectorTags matching.
//   - When multiple sectors match, take the union (deduped by key).

export interface ExtendedMetricDef {
  key: string;
  label: string;
  unit: string; // "USD_m", "USD", "USD/shares", "pct", "kt", "boe/d", "cents/mile", "count", etc.
  hint: string; // instructs Claude what to look for and where (Item 2 MD&A, cash flow section, etc.)
  // A metric can be "point" (single number) or "range" (guidance-style: low/mid/high).
  shape?: "point" | "range";
}

export const UNIVERSAL_EXTENDED_METRICS: ExtendedMetricDef[] = [
  { key: "capex_total", label: "Capex (total)", unit: "USD_m",
    hint: "Total capital expenditures reported in the cash-flow statement or MD&A capex line. Sum property/plant + intangibles if broken out." },
  { key: "capex_adjusted", label: "Adjusted CapEx", unit: "USD_m",
    hint: "Management's adjusted-capex figure if disclosed (excludes acquisitions, one-time infrastructure, spectrum, etc.). Only when the filing labels it 'adjusted' or provides a reconciliation." },
  { key: "free_cash_flow_mgmt", label: "Free cash flow (mgmt def)", unit: "USD_m",
    hint: "Management's own FCF definition (operating cash flow − capex − sometimes lease payments). Take the labeled 'free cash flow' line, not a computed derivative." },
  { key: "buyback_qtr_usd", label: "Buyback (this quarter)", unit: "USD_m",
    hint: "Dollar value of common stock repurchased in the quarter. From the equity or cash flow statement." },
  { key: "dividend_per_share", label: "Dividend per share", unit: "USD/shares",
    hint: "Declared or paid dividend per share in the quarter. Common shares only." },
  { key: "sale_of_assets_usd", label: "Sale of assets", unit: "USD_m",
    hint: "Proceeds from asset divestitures / dispositions this quarter (property, subsidiaries, investments). Cash flow investing section." },
  { key: "eps_non_gaap", label: "Non-GAAP EPS", unit: "USD/shares",
    hint: "Management's non-GAAP or adjusted EPS. Take diluted if both basic + diluted are given." },
  { key: "guidance_revenue_next_q", label: "Guidance · next-Q revenue", unit: "USD_m", shape: "range",
    hint: "Management's forward guidance for the NEXT reporting quarter's revenue. If given as a range, capture low/mid/high; if point, only mid. From the outlook / guidance section of the release." },
  { key: "guidance_eps_next_q", label: "Guidance · next-Q EPS", unit: "USD/shares", shape: "range",
    hint: "Management's forward guidance for next-Q EPS. Range or point per above." },
];

export const SECTOR_EXTENDED_METRICS: Record<string, ExtendedMetricDef[]> = {
  // ---- Miners ----
  mining: [
    { key: "production_cu_kt", label: "Copper production", unit: "kt",
      hint: "Copper produced in the quarter, kilotonnes. Operational KPI section." },
    { key: "production_au_koz", label: "Gold production", unit: "koz",
      hint: "Gold produced this quarter in thousand ounces." },
    { key: "c1_cash_cost", label: "C1 cash cost (Cu)", unit: "USD/lb",
      hint: "C1 or by-product cash cost per pound of copper." },
    { key: "aisc_gold", label: "AISC (Au)", unit: "USD/oz",
      hint: "All-in sustaining cost per ounce of gold." },
    { key: "grade_head", label: "Head grade", unit: "gpt-or-pct",
      hint: "Ore head grade — g/t for gold-silver, % for copper. Include units in the value." },
    { key: "recovery_pct", label: "Recovery", unit: "pct",
      hint: "Metallurgical recovery percentage this quarter." },
    { key: "sustaining_capex", label: "Sustaining capex", unit: "USD_m",
      hint: "Sustaining vs growth capex split when the miner breaks it out." },
  ],

  // ---- Banks / Financials ----
  financials: [
    { key: "nim", label: "Net interest margin", unit: "pct",
      hint: "Net interest margin, expressed as a percentage. From the interest-income section." },
    { key: "efficiency_ratio", label: "Efficiency ratio", unit: "pct",
      hint: "Non-interest expense / (net interest income + non-interest income)." },
    { key: "cet1_ratio", label: "CET1 ratio", unit: "pct",
      hint: "Common Equity Tier 1 capital ratio (Basel III)." },
    { key: "rotce", label: "Return on tangible common equity", unit: "pct",
      hint: "ROTCE for the quarter." },
    { key: "net_chargeoff_ratio", label: "Net charge-off ratio", unit: "pct",
      hint: "Net charge-offs as % of average loans." },
    { key: "deposits_balance", label: "Deposits balance", unit: "USD_m",
      hint: "Total deposits at quarter-end." },
    { key: "provision_credit_losses", label: "Provision for credit losses", unit: "USD_m",
      hint: "PCL / PCLL for the quarter." },
  ],

  // ---- SaaS / Software / Technology ----
  software: [
    { key: "arr", label: "ARR", unit: "USD_m",
      hint: "Annual recurring revenue at quarter-end." },
    { key: "ndr", label: "Net dollar retention", unit: "pct",
      hint: "Net revenue retention or net dollar retention rate." },
    { key: "crpo", label: "cRPO (current remaining perf obligation)", unit: "USD_m",
      hint: "Current portion of remaining performance obligation." },
    { key: "rpo_total", label: "RPO (total)", unit: "USD_m",
      hint: "Total remaining performance obligation." },
    { key: "fcf_margin", label: "FCF margin", unit: "pct",
      hint: "Free cash flow as % of revenue." },
    { key: "sm_pct_revenue", label: "S&M % of revenue", unit: "pct",
      hint: "Sales & marketing spend as % of revenue." },
    { key: "rd_pct_revenue", label: "R&D % of revenue", unit: "pct",
      hint: "R&D spend as % of revenue." },
  ],

  // ---- Consumer / Retail ----
  "consumer-cyclical": [
    { key: "comp_sales", label: "Comparable sales", unit: "pct",
      hint: "Same-store or comparable sales growth this quarter." },
    { key: "avg_ticket", label: "Average ticket", unit: "USD",
      hint: "Average transaction ticket / basket size." },
    { key: "transactions", label: "Transactions / traffic", unit: "count-m",
      hint: "Number of transactions or traffic count (millions). Store count if traffic not disclosed." },
    { key: "store_count", label: "Store count", unit: "count",
      hint: "Total store count at quarter-end." },
    { key: "ecom_pct", label: "E-commerce % of revenue", unit: "pct",
      hint: "E-commerce share of total revenue." },
    { key: "aur", label: "Average unit retail (AUR)", unit: "USD",
      hint: "Average selling price per unit if reported." },
  ],
  "consumer-defensive": [
    { key: "comp_sales", label: "Comparable sales", unit: "pct", hint: "Same-store sales growth." },
    { key: "organic_growth", label: "Organic revenue growth", unit: "pct",
      hint: "Organic (constant-currency, no acquisitions) revenue growth." },
    { key: "avg_ticket", label: "Average ticket", unit: "USD", hint: "Basket size." },
    { key: "transactions", label: "Transactions", unit: "count-m", hint: "Transaction count in millions." },
  ],

  // ---- Energy — upstream / midstream / integrated ----
  energy: [
    { key: "production_boe_d", label: "Production", unit: "boe/d",
      hint: "Total production in barrels-of-oil-equivalent per day (thousands)." },
    { key: "realized_price_oil", label: "Realized oil price", unit: "USD/bbl",
      hint: "Realized crude price per barrel this quarter." },
    { key: "realized_price_gas", label: "Realized gas price", unit: "USD/mcf",
      hint: "Realized natural gas price per mcf." },
    { key: "lifting_cost", label: "Lifting cost", unit: "USD/boe",
      hint: "Production / lifting cost per boe." },
    { key: "netback", label: "Netback", unit: "USD/boe",
      hint: "Realized price − royalties − opex per boe." },
    { key: "hedge_pl", label: "Hedge P&L", unit: "USD_m",
      hint: "Realized + unrealized hedging gain/loss this quarter." },
  ],
  "oil-gas": [
    { key: "production_boe_d", label: "Production", unit: "boe/d", hint: "Total production, boe/d." },
    { key: "realized_price_oil", label: "Realized oil price", unit: "USD/bbl", hint: "Realized oil price." },
    { key: "realized_price_gas", label: "Realized gas price", unit: "USD/mcf", hint: "Realized gas price." },
  ],

  // ---- Healthcare / Pharma ----
  healthcare: [
    { key: "segment_sales_top", label: "Top segment revenue", unit: "USD_m",
      hint: "Largest reporting segment's revenue this quarter (with segment name)." },
    { key: "gross_to_net", label: "Gross-to-net %", unit: "pct",
      hint: "GTN rate — rebates and discounts as % of gross sales, when disclosed." },
    { key: "rd_pct_revenue", label: "R&D % of revenue", unit: "pct", hint: "R&D as % of rev." },
  ],

  // ---- Industrials ----
  industrials: [
    { key: "backlog", label: "Backlog", unit: "USD_m",
      hint: "Order backlog at quarter-end." },
    { key: "book_to_bill", label: "Book-to-bill", unit: "ratio",
      hint: "New orders / revenue this quarter." },
    { key: "organic_growth", label: "Organic revenue growth", unit: "pct",
      hint: "Organic (ex-FX, ex-acq) revenue growth." },
    { key: "price_cost_impact", label: "Price/cost impact", unit: "USD_m",
      hint: "Net price/cost impact on operating income if disclosed." },
  ],

  // ---- Real estate / REITs ----
  "real-estate": [
    { key: "ffo_per_share", label: "FFO / share", unit: "USD/shares",
      hint: "Funds From Operations per diluted share." },
    { key: "affo_per_share", label: "AFFO / share", unit: "USD/shares",
      hint: "Adjusted FFO per share." },
    { key: "ss_noi_growth", label: "Same-store NOI growth", unit: "pct",
      hint: "Same-store or same-property NOI growth this quarter." },
    { key: "occupancy_pct", label: "Occupancy", unit: "pct",
      hint: "Portfolio occupancy at quarter-end." },
    { key: "released_spread", label: "Released spread", unit: "pct",
      hint: "Rent spreads on lease renewals / new leases." },
  ],

  // ---- Communications / Semiconductors ----
  technology: [
    { key: "arr", label: "ARR", unit: "USD_m", hint: "Annual recurring revenue." },
    { key: "wafer_starts", label: "Wafer starts / capacity utilization", unit: "pct",
      hint: "For semis: capacity utilization or wafer starts." },
    { key: "capex_intensity", label: "Capex intensity", unit: "pct",
      hint: "Capex / revenue this quarter." },
  ],
};

/** Compose the metric list for an entity. Universal always included; sector
 *  layers added if their tag matches one of the entity's sectorTags. Deduped
 *  by key (Universal wins ties). */
export function extendedMetricsForEntity(
  entity: { sectorTags?: string[] } | null | undefined,
): ExtendedMetricDef[] {
  const seen = new Set<string>();
  const out: ExtendedMetricDef[] = [];
  for (const m of UNIVERSAL_EXTENDED_METRICS) {
    seen.add(m.key);
    out.push(m);
  }
  for (const tag of entity?.sectorTags ?? []) {
    const set = SECTOR_EXTENDED_METRICS[tag] ?? [];
    for (const m of set) {
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      out.push(m);
    }
  }
  return out;
}
