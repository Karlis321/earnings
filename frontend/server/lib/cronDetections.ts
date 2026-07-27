// Cron detection helpers — next-event upsert + restatement checks.
//
// Both consume yahooEarnings() output. Kept out of the cron route file so
// the pure logic can be unit-tested (period parsing + Δ math) without
// spinning up the whole cron.

import type {
  EventRecord,
  Entity,
  Fact,
  Horizon,
  MetricEntry,
  ReactionPoint,
} from "@/lib/types";
import type { YahooEarnings } from "@/server/vendors/yahoo";

const HORIZONS: Horizon[] = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS: Record<Horizon, number> = {
  d1: 1,
  d3: 3,
  w1: 5,
  m1: 21,
};

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

// Build a past-quarter event record with the reported actual baked in.
// Used by the backfill and by POST /api/entity-registry auto-backfill so
// a newly-added ticker lands with its past 4Q of history already visible
// on the security detail page.
export function buildPastEvent(
  entity: Entity,
  quarter: { period: string; actual: number | null; estimate: number | null },
  yahooSymbol: string,
): EventRecord | null {
  const parsed = parseYahooPeriod(quarter.period);
  if (!parsed) return null;
  const scheduledDate = reportingDateForPeriod(quarter.period);
  if (!scheduledDate) return null;
  const periodLabel = `FY${parsed.year} Q${parsed.quarter}`;
  const id = nextEventId(entity.ticker, scheduledDate);
  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);

  const metrics: MetricEntry[] = [];
  // Seed the primary EPS metric from Yahoo — that's what the earnings
  // chart returns. Other headline metrics land through manual entry or
  // future ingestion, so they get null Facts as placeholders.
  for (const key of entity.headlineMetrics) {
    const isEps = /^eps/i.test(key);
    const estimateVal = isEps ? quarter.estimate : null;
    const actualVal = isEps ? quarter.actual : null;
    const surprisePct =
      estimateVal !== null &&
      actualVal !== null &&
      Math.abs(estimateVal) > 1e-9
        ? ((actualVal - estimateVal) / Math.abs(estimateVal)) * 100
        : null;
    metrics.push({
      key,
      displayLabel: key,
      isHeadline: true,
      surprisePct,
      estimate:
        estimateVal !== null
          ? {
              value: estimateVal,
              unit: "USD",
              source: {
                url: `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/analysis`,
                label: "Yahoo Finance (consensus)",
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
              unit: "USD",
              source: {
                url: `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/earnings`,
                label: "Yahoo Finance",
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
    metrics,
    guidance: [],
    reaction: {
      benchmark: entity.benchmark,
      baselineDate: null,
      baselineClose: null,
      // Past-event horizons are not yet backfilled with real close-vs-baseline
      // numbers — needs a bar-fetch pass separately. Empty points for now.
      points: [],
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
