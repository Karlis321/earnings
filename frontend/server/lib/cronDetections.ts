// Cron detection helpers — next-event upsert + restatement checks.
//
// Both consume yahooEarnings() output. Kept out of the cron route file so
// the pure logic can be unit-tested (period parsing + Δ math) without
// spinning up the whole cron.

import type {
  EventProvenance,
  EventRecord,
  Entity,
  Fact,
  Horizon,
  MetricEntry,
  ReactionPoint,
  SourceLink,
} from "@/lib/types";
import type { YahooEarnings } from "@/server/vendors/yahoo";

// ---------- Source-link derivation ----------
//
// Every event carries a "Source" click-through. Rules by provenance:
//   sec-submissions       → direct filing URL from filing_reference metric  → filing
//   sec-xbrl-companyfacts → resolved accession URL from submissions cache   → filing
//                           (falls back to EDGAR filings-index page)        → fallback
//   yahoo-timeseries      → Yahoo financials page for the symbol            → fallback
//   yahoo-earnings-chart  → Yahoo financials page for the symbol            → fallback
//   fmp                   → FMP income-statement page for the symbol        → fallback
//   estimator-median-gap  → no data yet                                     → null
//   manual-entry, fixture → nothing to link                                 → null
//
// Kept in cronDetections.ts (rather than a separate module) because every
// cron event-creation site imports from here already.

// One resolved filing entry from SEC submissions. Callers precompute a
// per-CIK lookup once per run and pass it in so this function stays pure.
export interface AccessionCandidate {
  form: string; // "10-Q" | "10-K" | "20-F" | "40-F" | "6-K"
  filingDate: string; // ISO YYYY-MM-DD
  accessionNumber: string; // "0000320193-24-000005" (with dashes)
  primaryDocument: string; // "aapl-20240330.htm"
}

// paddedCik → sorted candidate list. Preferred forms first, then closest
// filingDate wins in matchAccession.
export type AccessionLookup = Map<string, AccessionCandidate[]>;

// Preferred SEC forms for periodic earnings reports, in decreasing trust.
const PREFERRED_FORMS = ["10-Q", "10-K", "20-F", "40-F", "6-K"] as const;

// Match an event to its accession filing. Returns null if no candidate is
// within ±14 days OR the CIK has no submissions cached.
export function matchAccession(
  event: EventRecord,
  entity: Entity | undefined,
  lookup: AccessionLookup | undefined,
): AccessionCandidate | null {
  if (!lookup || !entity?.edgarCik) return null;
  const padded = String(entity.edgarCik).padStart(10, "0");
  const candidates = lookup.get(padded);
  if (!candidates || candidates.length === 0) return null;
  const anchorIso = event.eventDate ?? event.scheduledDate;
  if (!anchorIso) return null;
  const anchor = new Date(anchorIso).getTime();
  const isFY = /^FY\d{4}$/.test((event.period ?? "").trim());
  // Prefer 10-K for FY-only periods, otherwise 10-Q or foreign equivalents.
  const preferForm = (form: string): number => {
    if (isFY && (form === "10-K" || form === "20-F")) return 0;
    if (!isFY && (form === "10-Q" || form === "6-K")) return 0;
    return 1;
  };
  let best: { c: AccessionCandidate; diff: number; rank: number } | null = null;
  for (const c of candidates) {
    const diffDays =
      Math.abs(new Date(c.filingDate).getTime() - anchor) / 86_400_000;
    if (diffDays > 14) continue;
    const rank = preferForm(c.form);
    const score = { c, diff: diffDays, rank };
    if (
      !best ||
      score.rank < best.rank ||
      (score.rank === best.rank && score.diff < best.diff)
    ) {
      best = score;
    }
  }
  return best?.c ?? null;
}

// Build the canonical /Archives/edgar/data/<cik>/<accessionNoDashes>/<primary>
// URL. `cikNoLeading` drops leading zeros — required by the archive layout.
export function buildAccessionUrl(
  paddedCik: string,
  accessionNumber: string,
  primaryDocument: string,
): string {
  const cikNoLeading = String(Number(paddedCik));
  const accNoDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accNoDashes}/${primaryDocument}`;
}

export function computeSourceLink(
  event: EventRecord,
  entity: Entity | undefined,
  // Optional pre-resolved lookup, keyed by padded CIK. When present we
  // upgrade sec-xbrl-companyfacts / sec-submissions events to direct
  // filing URLs. Absent → existing fallback behavior (no vendor calls
  // from inside this function — cron pre-fetches submissions per run).
  accessionLookup?: AccessionLookup,
): SourceLink | null {
  const prov = event.provenance;
  const symbol = entity?.yahooSymbol ?? event.ticker.split(/\s+/)[0];

  if (prov === "sec-submissions") {
    // Filing URL already lives on the filing_reference metric's actual.source.url.
    const fr = (event.metrics ?? []).find(
      (m) => m.key === "filing_reference",
    );
    const url = fr?.actual?.source?.url ?? null;
    if (url) return { url, kind: "filing" };
    // Fall through — try the accession lookup if we have it.
    if (accessionLookup && entity?.edgarCik) {
      const match = matchAccession(event, entity, accessionLookup);
      if (match) {
        const padded = String(entity.edgarCik).padStart(10, "0");
        return {
          url: buildAccessionUrl(padded, match.accessionNumber, match.primaryDocument),
          kind: "filing",
        };
      }
    }
    // Fall through to xbrl fallback branch below if still unresolved.
  }

  if (prov === "sec-xbrl-companyfacts" || prov === "sec-submissions") {
    if (!entity?.edgarCik) return null;
    const paddedCik = String(entity.edgarCik).padStart(10, "0");

    // Direct filing URL when the lookup carries the accession.
    const match = matchAccession(event, entity, accessionLookup);
    if (match) {
      return {
        url: buildAccessionUrl(paddedCik, match.accessionNumber, match.primaryDocument),
        kind: "filing",
      };
    }

    // Prefer 10-K for FY-only events (period ends with "FY" and has no Q slot).
    const isFiscalYear = /^FY\d{4}$/.test((event.period ?? "").trim());
    const type = isFiscalYear ? "10-K" : "10-Q";
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(type)}&dateb=&owner=include&count=40`;
    return { url, kind: "fallback" };
  }

  if (prov === "yahoo-timeseries" || prov === "yahoo-earnings-chart") {
    if (!symbol) return null;
    return {
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials`,
      kind: "fallback",
    };
  }

  if (prov === "fmp") {
    if (!symbol) return null;
    return {
      url: `https://financialmodelingprep.com/financial-statements/${encodeURIComponent(symbol)}`,
      kind: "fallback",
    };
  }

  // estimator-median-gap / manual-entry / fixture / undefined → null
  return null;
}

// Extract the per-CIK candidate list from a raw SEC submissions JSON.
// Callers fetch once per CIK per run and pass the body here.
export function candidatesFromSubmissions(sub: unknown): AccessionCandidate[] {
  const s = sub as {
    filings?: {
      recent?: {
        form?: string[];
        filingDate?: string[];
        accessionNumber?: string[];
        primaryDocument?: string[];
      };
    };
  };
  const recent = s?.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const accs = recent.accessionNumber ?? [];
  const docs = recent.primaryDocument ?? [];
  const out: AccessionCandidate[] = [];
  const allowed = new Set<string>(PREFERRED_FORMS);
  for (let i = 0; i < forms.length; i++) {
    if (!allowed.has(forms[i])) continue;
    const acc = accs[i];
    const doc = docs[i];
    const date = dates[i];
    if (!acc || !doc || !date) continue;
    out.push({
      form: forms[i],
      filingDate: date,
      accessionNumber: acc,
      primaryDocument: doc,
    });
  }
  return out;
}

// Provenance rank — higher wins on conflict. Mirrors scripts/backfills/dedupe-events.mjs
// so cron merges use the same ordering as the offline dedup pass. See audit
// finding (capability e — merge-on-incoming).
export const PROVENANCE_RANK: Record<string, number> = {
  "sec-xbrl-companyfacts": 100,
  "yahoo-timeseries": 90,
  "yahoo-earnings-chart": 80,
  fmp: 70,
  "manual-entry": 60,
  "sec-submissions": 20,
  "estimator-median-gap": 10,
  fixture: 5,
  unknown: 0,
};

function provRank(p: EventProvenance | string | undefined | null): number {
  return PROVENANCE_RANK[p ?? "unknown"] ?? 0;
}

const HORIZONS: Horizon[] = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS: Record<Horizon, number> = {
  d1: 1,
  d3: 3,
  w1: 5,
  m1: 21,
};

// Seed the four reaction horizons for an event that landed with points: []
// (past events built under the old buildPastEvent code). Idempotent —
// returns the same reference when points already exist.
export function seedReactionPoints(event: EventRecord): EventRecord {
  if (event.reaction.points.length > 0) return event;
  const anchor = event.eventDate ?? event.scheduledDate;
  const points: ReactionPoint[] = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: event.reaction.benchmark ?? "",
    computedAt: null,
    populatesOn: horizonPopulatesOn(anchor, h),
  }));
  return {
    ...event,
    reaction: { ...event.reaction, points },
  };
}

// Yahoo's earningsChart.quarterly.date labels: "1Q2026", "4Q2025", etc.
export function parseYahooPeriod(
  s: string,
): { year: number; quarter: number } | null {
  const m = s.trim().match(/^(\d)Q(\d{4})$/);
  if (!m) return null;
  return { quarter: Number(m[1]), year: Number(m[2]) };
}

// Stored period labels: "FY2026 Q1", "FY 2026 Q1".
export function parseStoredPeriod(
  s: string,
): { year: number; quarter: number } | null {
  const m = s.trim().match(/FY\s*(\d{4})\s+Q(\d)/i);
  if (!m) return null;
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

// Derive the reporting period from the announced reporting date.
// Companies typically report their prior quarter — so a reporting date
// in Apr-Jun covers Q1 of that calendar year, Jul-Sep covers Q2, etc.
// This is a heuristic; the correct value on the earnings row (once it
// has one) supersedes what we derive.
export function periodFromReportingDate(iso: string): {
  label: string;
  year: number;
  quarter: number;
} {
  const d = new Date(iso);
  const m = d.getUTCMonth() + 1;
  const y = d.getUTCFullYear();
  let quarter: number;
  let year: number;
  if (m <= 3) {
    quarter = 4;
    year = y - 1;
  } else if (m <= 6) {
    quarter = 1;
    year = y;
  } else if (m <= 9) {
    quarter = 2;
    year = y;
  } else {
    quarter = 3;
    year = y;
  }
  return { label: `FY${year} Q${quarter}`, year, quarter };
}

// Stable id for a not-yet-existing event. Deterministic so the same
// upsert on a later cron run doesn't create a duplicate.
export function nextEventId(ticker: string, scheduledDate: string): string {
  const key = `${ticker}::${scheduledDate}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const base36 = (h >>> 0).toString(36).padStart(7, "0").slice(0, 8);
  return `evt-${base36}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Rough calendar-day mapping for pre-seeded populatesOn stamps. Actual
// maturation runs on trading-session offsets against real Yahoo bars —
// this is just a hint for the UI ("populates <date>") until the cron
// fills in the real absReturn.
function horizonPopulatesOn(scheduledDate: string, horizon: Horizon): string {
  const calDays = HORIZON_TRADING_DAYS[horizon] + 2; // add slack for weekends
  return addDays(scheduledDate, calDays);
}

// Convert a Yahoo period label ("2Q2026") to an approximate reporting
// date (mid-quarter after the fiscal quarter ends). Companies report
// their Q2 results ~mid-July → we use the 15th of the month after
// quarter-end as a reasonable stand-in when we don't have the actual
// reported date.
function reportingDateForPeriod(period: string): string | null {
  const parsed = parseYahooPeriod(period);
  if (!parsed) return null;
  const monthAfterQEnd: Record<number, number> = { 1: 4, 2: 7, 3: 10, 4: 1 };
  const mo = monthAfterQEnd[parsed.quarter];
  const yr = parsed.quarter === 4 ? parsed.year + 1 : parsed.year;
  return `${yr}-${String(mo).padStart(2, "0")}-15`;
}

// Readable display labels for headline metric keys. Kept in sync with
// data/metric-dictionary.json so the UI never shows raw snake_case.
const METRIC_LABEL_BY_KEY: Record<string, { label: string; unit: string }> = {
  revenue_usd_m: { label: "Revenue (M)", unit: "USD" },
  revenue_eur_m: { label: "Revenue (M)", unit: "EUR" },
  ebitda_usd_m: { label: "EBITDA (M)", unit: "USD" },
  adj_ebitda_usd_m: { label: "Adj. EBITDA (M)", unit: "USD" },
  eps_usd: { label: "EPS", unit: "USD" },
  eps_eur: { label: "EPS", unit: "EUR" },
  eps_cad: { label: "EPS", unit: "CAD" },
  dr_eps_usd: { label: "DR EPS", unit: "USD" },
  fee_bearing_capital_usd_b: { label: "Fee-bearing capital (B)", unit: "USD" },
  data_center_rev_usd_m: { label: "Data-center revenue (M)", unit: "USD" },
  production_cu_kt: { label: "Copper production (kt)", unit: "kt" },
  c1_usd_lb: { label: "C1 cash cost", unit: "USD/lb" },
  shipments_kt: { label: "Shipments (kt)", unit: "kt" },
  iron_ore_kt: { label: "Iron ore (kt)", unit: "kt" },
  adj_op_margin_pct: { label: "Adj. op margin", unit: "%" },
  u3o8_production_mlb: { label: "U₃O₈ (Mlb)", unit: "Mlb" },
  avg_realized_usd_lb: { label: "Realized price", unit: "USD/lb" },
  silver_production_koz: { label: "Silver (koz)", unit: "koz" },
  aisc_usd_oz: { label: "AISC", unit: "USD/oz" },
  arr_usd_m: { label: "ARR (M)", unit: "USD" },
  net_dollar_retention_pct: { label: "Net dollar retention", unit: "%" },
  daily_volumes_usd_b: { label: "Avg daily volume (B)", unit: "USD" },
  revenue_take_bps: { label: "Take rate", unit: "bps" },
};
function labelFor(key: string): { label: string; unit: string } {
  return METRIC_LABEL_BY_KEY[key] ?? { label: key, unit: "USD" };
}

// Build a past-quarter event record with the reported actual baked in.
// Used by the backfill and by POST /api/entity-registry auto-backfill so
// a newly-added ticker lands with its past 4Q of history already visible
// on the security detail page.
export function buildPastEvent(
  entity: Entity,
  quarter: {
    period: string;
    actual: number | null;
    estimate: number | null;
    revenue?: number | null;
    netIncome?: number | null;
  },
  yahooSymbol: string,
  // Audit finding (capability g — currency per data point). When the
  // upstream data source returns a reporting currency (Yahoo's
  // financialCurrency, FMP's reportedCurrency), pass it through so we
  // stamp the actual metric `unit` with the real filing currency instead
  // of METRIC_LABEL_BY_KEY's default (usually "USD" for revenue_usd_m).
  currency?: string,
): EventRecord | null {
  const parsed = parseYahooPeriod(quarter.period);
  if (!parsed) return null;
  const scheduledDate = reportingDateForPeriod(quarter.period);
  if (!scheduledDate) return null;
  const periodLabel = `FY${parsed.year} Q${parsed.quarter}`;
  const id = nextEventId(entity.ticker, scheduledDate);
  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);

  const yahooEarningsUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/earnings`;
  const yahooFinancialsUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/financials`;
  const yahooAnalysisUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/analysis`;

  const metrics: MetricEntry[] = [];
  const epsKeys = new Set(
    entity.headlineMetrics.filter((k) => /eps/i.test(k)),
  );
  const includeStandaloneEps =
    epsKeys.size === 0 && quarter.actual !== null;
  const keysToWrite = includeStandaloneEps
    ? [...entity.headlineMetrics, "eps_usd"]
    : entity.headlineMetrics;

  // Revenue from earnings.financialsChart.quarterly.revenue (absolute $).
  // We scale to millions for revenue_*_m keys so the UI matches its label.
  const revenueRaw = quarter.revenue ?? null;
  const revenueM = revenueRaw !== null ? revenueRaw / 1_000_000 : null;

  for (const key of keysToWrite) {
    const meta = labelFor(key);
    const isEps = /eps/i.test(key);
    const isRevenueM = /^revenue_[a-z]{3}_m$/.test(key);
    // Currency-per-data-point (audit finding): for currency-bearing scalar
    // keys, override meta.unit with the real reporting currency when the
    // caller passed one. Keeps non-currency keys (kt, %, USD/lb, …) intact.
    const isCurrencyBearing = isEps || /_m$/.test(key);
    const effectiveUnit =
      currency && isCurrencyBearing ? currency : meta.unit;

    let estimateVal: number | null = null;
    let actualVal: number | null = null;
    let sourceUrlActual = yahooEarningsUrl;
    // Stage 1B gate: label as earningsChart so isSameBasis can match.
    let sourceLabelActual = "Yahoo · earningsChart";

    if (isEps) {
      estimateVal = quarter.estimate;
      actualVal = quarter.actual;
    } else if (isRevenueM) {
      actualVal = revenueM;
      sourceUrlActual = yahooFinancialsUrl;
      sourceLabelActual = "Yahoo Finance · financials";
    }
    // Non-EPS non-revenue metrics stay null (need manual entry or filing
    // ingest). displayLabel still resolves to the readable form.

    // Only compute surprise for EPS — actual + estimate come from the
    // same earningsChart quarterly entry (matched basis). Revenue's
    // estimate isn't in this endpoint's pair, so no surprise stored
    // here (a wrong surprise is worse than none — see Stage 1B fix).
    const surprisePct =
      isEps &&
      estimateVal !== null &&
      actualVal !== null &&
      Math.abs(estimateVal) > 1e-9
        ? ((actualVal - estimateVal) / Math.abs(estimateVal)) * 100
        : null;

    metrics.push({
      key,
      displayLabel: meta.label,
      isHeadline: entity.headlineMetrics.includes(key),
      surprisePct,
      estimate:
        estimateVal !== null
          ? {
              value: estimateVal,
              unit: effectiveUnit,
              source: {
                url: yahooAnalysisUrl,
                label: "Yahoo Finance · consensus",
                provenance: "wire",
                locator: null,
              },
              asOf,
              fetchedAt: now,
              method: "yahoo",
              confidence: 0.75,
            }
          : null,
      actual:
        actualVal !== null
          ? {
              value: actualVal,
              unit: effectiveUnit,
              source: {
                url: sourceUrlActual,
                label: sourceLabelActual,
                provenance: "wire",
                locator: null,
              },
              asOf,
              fetchedAt: now,
              method: "yahoo",
              confidence: 0.85,
            }
          : null,
      prior: null,
    });
  }

  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period: periodLabel,
    scheduledDate,
    eventDate: scheduledDate, // past events — reported date == scheduled
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "yahoo-earnings-chart",
    provenanceAsOf: now,
    metrics,
    guidance: [],
    reaction: {
      benchmark: entity.benchmark,
      // Left null here — matureEventReaction seeds baselineDate +
      // baselineClose from the security's own bars on the first cron
      // pass after this event lands, then matures every horizon whose
      // populatesOn is already past.
      baselineDate: null,
      baselineClose: null,
      points: HORIZONS.map((h) => ({
        horizon: h,
        absReturn: null,
        excessReturn: null,
        benchmark: entity.benchmark,
        computedAt: null,
        populatesOn: horizonPopulatesOn(scheduledDate, h),
      })),
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

// Promote an existing shell to a completed past event, in place.
//
// When Yahoo's `calendarEvents.earningsDate` marks Aug 5 for Q2 2026, we
// create a shell (via `buildEventShell`) with `scheduledDate=2026-08-05,
// eventDate=null`. Come Aug 6 morning cron, Yahoo's
// `earningsChart.quarterly` now includes 2Q2026 with the actual EPS +
// revenue. We upgrade the SAME event record so:
//
//   - `eventDate = scheduledDate` (the real report day, not the
//     mid-month stand-in that `buildPastEvent` uses when there was no
//     prior shell)
//   - Metric actuals + estimates come from Yahoo's chart
//   - `reaction.points[i].populatesOn` are recomputed off the real date
//   - `reaction.baselineDate` / `baselineClose` stay null so
//     `matureEventReaction` seeds them from bars using the correct
//     scheduledDate on the next pass (or same pass if it runs after)
//
// The metric fill logic mirrors buildPastEvent so the two paths produce
// identical records — same displayLabel, same source URLs, same units.
export function promoteShellToPast(
  event: EventRecord,
  quarter: {
    period: string;
    actual: number | null;
    estimate: number | null;
    revenue?: number | null;
    netIncome?: number | null;
  },
  entity: Entity,
  yahooSymbol: string,
  // Currency-per-data-point (audit finding). Same pass-through as
  // buildPastEvent — Yahoo's financialCurrency / FMP's reportedCurrency
  // override the METRIC_LABEL_BY_KEY default unit for currency-bearing keys.
  currency?: string,
): EventRecord {
  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);
  const earningsUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/earnings`;
  const financialsUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/financials`;
  const analysisUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/analysis`;

  const epsKeys = new Set(entity.headlineMetrics.filter((k) => /eps/i.test(k)));
  const includeStandaloneEps = epsKeys.size === 0 && quarter.actual !== null;
  const keysToWrite = includeStandaloneEps
    ? [...entity.headlineMetrics, "eps_usd"]
    : entity.headlineMetrics;
  const revenueM = quarter.revenue != null ? quarter.revenue / 1_000_000 : null;

  const metrics: MetricEntry[] = keysToWrite.map((key) => {
    const meta = labelFor(key);
    const isEps = /eps/i.test(key);
    const isRevenueM = /^revenue_[a-z]{3}_m$/.test(key);
    const isCurrencyBearing = isEps || /_m$/.test(key);
    const effectiveUnit =
      currency && isCurrencyBearing ? currency : meta.unit;
    let estimateVal: number | null = null;
    let actualVal: number | null = null;
    let srcUrl = earningsUrl;
    // Stage 1B gate: label the source accurately so isSameBasis can
    // detect that actual + estimate come from the earningsChart pair
    // (a matched analyst-consensus sample). Without this the surprise%
    // gets suppressed at render as cross-basis, even though it's fine.
    let srcLabel = "Yahoo · earningsChart";
    if (isEps) {
      estimateVal = quarter.estimate;
      actualVal = quarter.actual;
    } else if (isRevenueM) {
      actualVal = revenueM;
      srcUrl = financialsUrl;
      srcLabel = "Yahoo Finance · financials";
    }
    // Surprise safe here — both sides come from the same earningsChart
    // quarterly entry (matched actual + estimate on the same basis).
    const surprisePct =
      isEps &&
      estimateVal !== null &&
      actualVal !== null &&
      Math.abs(estimateVal) > 1e-9
        ? ((actualVal - estimateVal) / Math.abs(estimateVal)) * 100
        : null;
    return {
      key,
      displayLabel: meta.label,
      isHeadline: entity.headlineMetrics.includes(key),
      surprisePct,
      estimate:
        estimateVal !== null
          ? {
              value: estimateVal,
              unit: effectiveUnit,
              source: { url: analysisUrl, label: "Yahoo · earningsChart (consensus)", provenance: "wire", locator: null },
              asOf,
              fetchedAt: now,
              method: "yahoo",
              confidence: 0.75,
            }
          : null,
      actual:
        actualVal !== null
          ? {
              value: actualVal,
              unit: effectiveUnit,
              source: { url: srcUrl, label: srcLabel, provenance: "wire", locator: null },
              asOf,
              fetchedAt: now,
              method: "yahoo",
              confidence: 0.85,
            }
          : null,
      prior: null,
    };
  });

  // Recompute populatesOn from the real date so reaction horizons no
  // longer point at a stand-in.
  const points = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: entity.benchmark,
    computedAt: null,
    populatesOn: horizonPopulatesOn(event.scheduledDate, h),
  }));

  return {
    ...event,
    // Promote the event to "past" — the scheduledDate WAS the real
    // announced date, so eventDate == scheduledDate now.
    eventDate: event.scheduledDate,
    metrics,
    reaction: {
      ...event.reaction,
      baselineDate: null,
      baselineClose: null,
      points,
    },
  };
}

// Given a past-quarter period label ("1Q2026"), find an existing shell
// event for the same ticker + parsed period. Returns null if no match.
export function findShellForPeriod(
  events: EventRecord[],
  ticker: string,
  yahooPeriod: string,
): EventRecord | null {
  const parsed = parseYahooPeriod(yahooPeriod);
  if (!parsed) return null;
  for (const ev of events) {
    if (ev.ticker !== ticker) continue;
    if (ev.eventDate) continue; // already reported — not a shell
    const p = parseStoredPeriod(ev.period);
    if (p && p.year === parsed.year && p.quarter === parsed.quarter) {
      return ev;
    }
  }
  return null;
}

// Build a minimal EventRecord shell for an announced future earnings date.
// baselineDate / baselineClose stay null until the event happens; a future
// cron run seeds them from the security's bars on the event day.
export function buildEventShell(
  entity: Entity,
  scheduledDate: string,
  period: string,
): EventRecord {
  const id = nextEventId(entity.ticker, scheduledDate);
  const points: ReactionPoint[] = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: entity.benchmark,
    computedAt: null,
    populatesOn: horizonPopulatesOn(scheduledDate, h),
  }));
  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period,
    scheduledDate,
    eventDate: null,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "yahoo-earnings-chart",
    provenanceAsOf: new Date().toISOString(),
    metrics: [],
    guidance: [],
    reaction: {
      benchmark: entity.benchmark,
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

// True when the entity already has an event covering this quarter — either
// same scheduledDate or same parsed period label. Avoids racing with a
// manually-created event whose date is a day off from Yahoo's.
export function alreadyHasEvent(
  events: EventRecord[],
  ticker: string,
  scheduledDate: string,
  period: string,
): boolean {
  const parsed = parseStoredPeriod(period);
  return events.some((e) => {
    if (e.ticker !== ticker) return false;
    if (e.scheduledDate === scheduledDate) return true;
    if (!parsed) return false;
    const p = parseStoredPeriod(e.period);
    return p ? p.year === parsed.year && p.quarter === parsed.quarter : false;
  });
}

// ---------- Restatement detection ----------

// Keys we treat as EPS for restatement comparison against Yahoo's actual.
// Yahoo's earningsChart.actual is EPS (adjusted, generally). We compare
// against any stored metric key that looks EPS-shaped.
const EPS_KEY_RE = /^eps(_|$)/i;

interface RestatementHit {
  eventId: string;
  ticker: string;
  metricKey: string;
  priorValue: number;
  restatedValue: number;
  deltaPct: number;
  at: string;
}

function facsimileFact(
  restated: number,
  unit: string,
  yahooSymbol: string,
  now: string,
  prior: Fact | null,
): Fact {
  return {
    value: restated,
    unit: prior?.unit ?? unit,
    source: {
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/earnings`,
      label: "Yahoo Finance (restated)",
      provenance: "wire",
      locator: null,
    },
    asOf: now.slice(0, 10),
    fetchedAt: now,
    method: "yahoo",
    confidence: prior?.confidence ?? 0.85,
  };
}

// Detect + apply restatements on one event. Returns the updated event
// (unchanged if no restatements) and the list of hits.
export function detectRestatements(
  event: EventRecord,
  entity: Entity,
  yahoo: YahooEarnings,
): { updated: EventRecord; hits: RestatementHit[] } {
  const last = yahoo.lastQuarter;
  if (!last || last.actual === null) return { updated: event, hits: [] };
  const yahooPeriod = parseYahooPeriod(last.period);
  const storedPeriod = parseStoredPeriod(event.period);
  if (
    !yahooPeriod ||
    !storedPeriod ||
    yahooPeriod.year !== storedPeriod.year ||
    yahooPeriod.quarter !== storedPeriod.quarter
  ) {
    return { updated: event, hits: [] };
  }

  const now = new Date().toISOString();
  const hits: RestatementHit[] = [];
  const nextMetrics: MetricEntry[] = event.metrics.map((m) => {
    if (!EPS_KEY_RE.test(m.key)) return m;
    const prior = m.actual;
    if (!prior || typeof prior.value !== "number") return m;
    const restated = last.actual!;
    const denom = Math.abs(prior.value);
    if (denom < 1e-9) return m;
    const deltaPct = (Math.abs(restated - prior.value) / denom) * 100;
    if (deltaPct < 0.5) return m;
    hits.push({
      eventId: event.id,
      ticker: entity.ticker,
      metricKey: m.key,
      priorValue: prior.value,
      restatedValue: restated,
      deltaPct,
      at: now,
    });
    return {
      ...m,
      actual: facsimileFact(restated, prior.unit, yahoo.yahooSymbol, now, prior),
    };
  });

  if (hits.length === 0) return { updated: event, hits: [] };
  return {
    updated: { ...event, metrics: nextMetrics },
    hits,
  };
}

// ---------- Merge-on-incoming (audit finding — capability e) ----------
//
// Every place that creates a new EventRecord in cron/daily should route
// through findMatchingEvent + mergeMetricsInto INSTEAD of pushing another
// row that dedupe-events.mjs will have to clean up later. Same behavior
// as the offline dedup script; higher provenance wins, losers move to
// `superseded[]`, nothing is silently dropped.

export interface SupersededMetric {
  key: string;
  value: number | null;
  unit: string;
  source: string | null;
  from_provenance: EventProvenance | string | null;
  from_event_id: string;
}

// Extend EventRecord in-memory with the merge bookkeeping fields (not on
// the public type — dedupe writes them today; we just make the cron write
// them shape-compatibly).
export type MergedEventRecord = EventRecord & {
  superseded?: SupersededMetric[];
  provenance_merged?: string[];
};

// Return the first event where:
//   (a) same ticker AND matching parsed period, OR
//   (b) same ticker AND both events have an eventDate/scheduledDate within 45 days.
// If either period or eventDate matches, that's the same underlying report cycle.
export function findMatchingEvent(
  events: EventRecord[],
  ticker: string,
  period: string,
  eventDate: string | null,
): EventRecord | null {
  const parsedIncoming = parseStoredPeriod(period);
  const targetTs = eventDate ? new Date(eventDate).getTime() : null;
  for (const ev of events) {
    if (ev.ticker !== ticker) continue;
    // (a) fiscal period match
    if (parsedIncoming) {
      const p = parseStoredPeriod(ev.period);
      if (p && p.year === parsedIncoming.year && p.quarter === parsedIncoming.quarter) {
        return ev;
      }
    } else if (ev.period === period && period) {
      return ev;
    }
    // (b) close-date match within 45d
    if (targetTs != null) {
      const anchor = ev.eventDate ?? ev.scheduledDate ?? null;
      if (anchor) {
        const diffDays = Math.abs(new Date(anchor).getTime() - targetTs) / 86_400_000;
        if (diffDays <= 45) return ev;
      }
    }
  }
  return null;
}

// Merge metrics from `incoming` into `target`:
//   - Target lacks the key (or target.actual.value is null) → enrich.
//   - Both present, incoming provenance rank > target's → swap; record
//     the losing metric to `superseded[]` so nothing is silently discarded.
//   - Otherwise target keeps; incoming loser moves to `superseded[]` if
//     it carried a distinct actual value.
// Also updates `provenance_merged` (sorted, unique).
export function mergeMetricsInto(
  target: EventRecord,
  incoming: EventRecord,
): MergedEventRecord {
  const merged: MergedEventRecord = { ...target };
  const targetRank = provRank(target.provenance);
  const incomingRank = provRank(incoming.provenance);

  const byKey = new Map<string, MetricEntry>();
  for (const m of target.metrics ?? []) byKey.set(m.key, m);

  const superseded: SupersededMetric[] = Array.isArray(
    (target as MergedEventRecord).superseded,
  )
    ? [...((target as MergedEventRecord).superseded as SupersededMetric[])]
    : [];

  for (const inc of incoming.metrics ?? []) {
    const cur = byKey.get(inc.key);
    if (!cur) {
      byKey.set(inc.key, inc);
      continue;
    }
    const curHasActual =
      cur.actual != null && cur.actual.value != null;
    const incHasActual =
      inc.actual != null && inc.actual.value != null;

    if (!curHasActual && incHasActual) {
      // Target null → fill it in regardless of provenance ordering.
      byKey.set(inc.key, { ...cur, ...inc });
      continue;
    }
    if (!incHasActual) continue;
    if (incomingRank > targetRank) {
      // Winner swap: current metric goes to superseded, incoming takes over.
      if (cur.actual?.value != null) {
        superseded.push({
          key: cur.key,
          value: cur.actual.value,
          unit: cur.actual.unit,
          source: cur.actual.source?.label ?? null,
          from_provenance: target.provenance ?? null,
          from_event_id: target.id,
        });
      }
      byKey.set(inc.key, inc);
    } else if (
      inc.actual?.value != null &&
      cur.actual?.value !== inc.actual.value
    ) {
      // Target keeps; incoming loser noted so nothing is silently discarded.
      superseded.push({
        key: inc.key,
        value: inc.actual.value,
        unit: inc.actual.unit,
        source: inc.actual.source?.label ?? null,
        from_provenance: incoming.provenance ?? null,
        from_event_id: incoming.id,
      });
    }
  }

  const provs = new Set<string>();
  const existingMerged = (target as MergedEventRecord).provenance_merged;
  if (Array.isArray(existingMerged)) existingMerged.forEach((p) => provs.add(p));
  if (target.provenance) provs.add(target.provenance);
  if (incoming.provenance) provs.add(incoming.provenance);
  const provenanceMerged = [...provs].sort();

  // EventDate refresh: when the target carries a shell-placeholder
  // date (mid-month 15th, from the estimator's projection) and the
  // incoming has a real report date (quarter-end or filed date), the
  // incoming's date is more truthful. Adopt it. Never overwrites a
  // real date with a shell — this is one-directional. The July-2026
  // audit found 1,765 events stuck with 15th placeholders because the
  // old merge kept the target's date unconditionally.
  const targetIs15 = /-15$/.test(target.eventDate ?? "");
  const incomingHasDate = !!incoming.eventDate;
  const incomingIsNot15 = !/-15$/.test(incoming.eventDate ?? "");
  if (targetIs15 && incomingHasDate && incomingIsNot15) {
    (merged as MergedEventRecord).eventDate = incoming.eventDate!;
    (merged as unknown as { eventDateSource: string }).eventDateSource =
      `merged-from-${incoming.provenance ?? "unknown"}`;
  }

  merged.metrics = [...byKey.values()];
  if (superseded.length > 0) merged.superseded = superseded;
  if (provenanceMerged.length > 0) merged.provenance_merged = provenanceMerged;
  return merged;
}

// ---------- Timeseries → EventRecord adapter (capability b support) ----------
//
// Convert a Yahoo fundamentals-timeseries bucket (asOfDate → per-key value)
// into a full EventRecord shaped like buildPastEvent's output. Used by the
// cron's per-entity Yahoo pass so the timeseries enrichment routes through
// the same merge-or-push path as everything else. Provenance is stamped
// as "yahoo-timeseries" at creation; unit comes from `d.currencyCode` on
// each metric (audit finding — currency per data point).
export function buildTimeseriesEvent(
  entity: Entity,
  yahooSymbol: string,
  asOfDate: string,
  bucket: Map<string, { value: number; currencyCode: string; label: string }>,
): EventRecord {
  const { year, quarter } = (() => {
    const d = new Date(asOfDate);
    return {
      year: d.getUTCFullYear(),
      quarter: Math.floor(d.getUTCMonth() / 3) + 1,
    };
  })();
  const periodLabel = `FY${year} Q${quarter}`;
  const id = nextEventId(entity.ticker, asOfDate);
  const now = new Date().toISOString();
  const financialsUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/financials`;

  const metrics: MetricEntry[] = [];
  for (const [key, m] of bucket) {
    metrics.push({
      key,
      displayLabel: m.label,
      isHeadline: entity.headlineMetrics?.includes(key) ?? false,
      surprisePct: null,
      estimate: null,
      actual: {
        value: m.value,
        // Currency per data point — audit finding.
        unit: m.currencyCode,
        source: {
          url: financialsUrl,
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

  const points: ReactionPoint[] = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: entity.benchmark ?? "",
    computedAt: null,
    populatesOn: horizonPopulatesOn(asOfDate, h),
  }));

  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period: periodLabel,
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
    reaction: {
      benchmark: entity.benchmark ?? "",
      baselineDate: null,
      baselineClose: null,
      points,
    },
    sources: {
      windowStart: addDays(asOfDate, -2),
      windowEnd: addDays(asOfDate, 35),
      capturedAt: null,
      items: [],
      engineStatus: [],
    },
  };
}
