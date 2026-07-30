// Continuous-integrity sanitizer for events written by the daily
// cron. Applies the three invariants my out-of-band sweeps enforce
// (currency-unit, same-basis surprise, absurd-surprise floor) so the
// cron never writes data that would need a follow-up manual cleanup.
//
// Called from route.ts step 4 (inside the mutateEarnings callback) so
// every event committed by cron passes these checks.

import type { Entity, EventRecord, Fact, MetricEntry } from "@/lib/types";

const ABSURD_THRESHOLD = 500; // percentage points

function isCurrencyBearing(key: string): boolean {
  if (/^eps/.test(key)) return true;
  if (/_[a-z]{3}_m$/.test(key)) return true;
  return false;
}

// Which "family" does this fact belong to? Facts from the same family
// are comparable head-to-head; cross-family comparisons produce
// mathematically-valid but semantically-meaningless ratios.
function provenanceFamily(fact: Fact | null | undefined): string {
  const l = fact?.source?.label ?? "";
  if (/SEC EDGAR|companyfacts|EarningsPerShare|10-Q|10-K|20-F/i.test(l)) return "sec";
  if (/submissions/i.test(l)) return "sec";
  if (/earningsChart/i.test(l)) return "yahoo-chart";
  if (/earningsTrend/i.test(l)) return "yahoo-trend";
  if (/fundamentals-timeseries/i.test(l)) return "yahoo-timeseries";
  if (/Yahoo Finance/i.test(l)) return "yahoo-generic";
  if (/FMP/i.test(l)) return "fmp";
  return "unknown";
}
function isSameBasis(a: Fact | null | undefined, e: Fact | null | undefined): boolean {
  const af = provenanceFamily(a);
  const ef = provenanceFamily(e);
  if (af === "unknown" || ef === "unknown") return false;
  if (af === ef) return true;
  const consensus = new Set(["yahoo-chart", "yahoo-trend"]);
  if (consensus.has(af) && consensus.has(ef)) return true;
  const gaapFiling = new Set(["sec", "yahoo-timeseries"]);
  if (gaapFiling.has(af) && gaapFiling.has(ef)) return true;
  if ((af === "sec" && ef === "fmp") || (af === "fmp" && ef === "sec")) return true;
  return false;
}

// Per-event sanitization. Mutates the event in place.
export function sanitizeEvent(event: EventRecord, entity: Entity): void {
  if (!Array.isArray(event.metrics)) return;
  for (const m of event.metrics) {
    sanitizeMetric(m as MetricEntry, entity);
  }
}

function sanitizeMetric(m: MetricEntry, entity: Entity): void {
  // 1. Currency-unit correction — Yahoo sometimes stamps 'USD' on
  //    values that are clearly in the entity's reporting currency
  //    (SK Hynix EPS 21,522 KRW labeled as USD). If the entity's
  //    currency is non-USD and the fact's unit is 'USD' on a
  //    currency-bearing key, override.
  if (entity.currency && entity.currency !== "USD" && isCurrencyBearing(m.key)) {
    for (const sideKey of ["actual", "estimate"] as const) {
      const f = (m[sideKey] as Fact | null | undefined) ?? undefined;
      if (f && f.unit === "USD" && f.value != null) {
        // Preserve original label for traceability.
        const fx = f as Fact & { _originalUnit?: string };
        if (!fx._originalUnit) fx._originalUnit = "USD";
        f.unit = entity.currency;
      }
    }
  }

  // 2. Cross-basis surprise clearing — if surprise% is set but the
  //    actual and estimate come from incompatible provenance
  //    families (SEC GAAP actual vs Yahoo consensus adjusted-EPS
  //    estimate), park the old value and clear the display side.
  if (m.surprisePct != null && m.actual?.value != null && m.estimate?.value != null) {
    if (!isSameBasis(m.actual, m.estimate)) {
      const mx = m as MetricEntry & { _crossBasisSurprise?: unknown[] };
      if (!Array.isArray(mx._crossBasisSurprise)) mx._crossBasisSurprise = [];
      mx._crossBasisSurprise.push({
        value: m.surprisePct,
        actualFamily: provenanceFamily(m.actual),
        estimateFamily: provenanceFamily(m.estimate),
        clearedAt: new Date().toISOString(),
        source: "cron-sanitize",
      });
      m.surprisePct = null;
    }
  }

  // 3. Absurd-surprise floor — |value| > 500% almost always signals
  //    corrupt data (near-zero estimate, mixed units) rather than a
  //    real earnings result. Suppress and park.
  if (m.surprisePct != null && Math.abs(m.surprisePct) > ABSURD_THRESHOLD) {
    const mx = m as MetricEntry & { _absurdSurprise?: unknown[] };
    if (!Array.isArray(mx._absurdSurprise)) mx._absurdSurprise = [];
    mx._absurdSurprise.push({
      value: m.surprisePct,
      actual: m.actual?.value ?? null,
      estimate: m.estimate?.value ?? null,
      clearedAt: new Date().toISOString(),
      source: "cron-sanitize",
      reason: "absurd_magnitude",
    });
    m.surprisePct = null;
  }
}

// Whole-snapshot sweep. Call this inside the cron's mutateEarnings
// callback with the snapshot's events + a registry lookup so every
// event gets the sanitizer applied on the way out.
export function sanitizeSnapshot(
  events: EventRecord[],
  entityByTicker: Map<string, Entity>,
): { events: EventRecord[]; touched: number } {
  let touched = 0;
  for (const ev of events) {
    const before = JSON.stringify(ev.metrics);
    const entity = entityByTicker.get(ev.ticker);
    if (!entity) continue;
    sanitizeEvent(ev, entity);
    if (JSON.stringify(ev.metrics) !== before) touched++;
  }
  return { events, touched };
}
