// Cadence-classifying estimator for missing next-event dates.
//
// Yahoo's `calendarEvents.earningsDate` is empty for most foreign
// wrappers and 40-F / 20-F filers, capping next-event coverage at ~3%
// via Yahoo alone. Our past-event coverage is 86%, so we have enough
// gap data to project forward — but the projection must honor the
// issuer's *reporting cadence*, not force everyone into a quarterly
// window.
//
// Cadence classification (post July-2026 rewrite):
//   - Compute all consecutive gaps between past-event dates
//   - Snap each gap to its nearest canonical cadence anchor:
//       quarterly  ~91 d
//       semiannual ~182 d
//       annual     ~365 d
//   - Pick the modal cadence class (most common snap target)
//   - Project forward from the latest past event using that cadence's
//     anchor days (not the raw median — a semi-annual filer with a
//     late Q1 shouldn't be projected 200 days out)
//
// Why cadence over median-gap:
//   BHP LN, RIO LN, ULVR LN, VIV FP file semi-annually. Their gaps
//   cluster around 182 days. The old 60–200 day quarterly window
//   accepted the ~182 semi-annual gap only barely, and any single 365 d
//   annual result blew the median past the ceiling → rejected → shown
//   as "unscheduled". Cadence classification recovers these names.
//
// Invariants preserved from the prior estimator:
//   - Requires ≥ 2 past events (need at least one gap)
//   - Requires last event within 540 days (older = likely delisted)
//   - Emits a shell with expectation="unset" and freshness="stale"
//     so the UI can hint that this date is projected, not confirmed
//   - Self-healing: a real Yahoo scheduledDate on the next cron
//     supersedes the estimate

import type { Cadence, EventRecord } from "@/lib/types";

const ESTIMATE_MIN_PAST_EVENTS = 2;
const ESTIMATE_MAX_LOOKBACK_DAYS = 540;
// Cadence anchors (days). Half-width tolerance below decides which
// class a raw gap snaps to.
const ANCHORS: Record<Exclude<Cadence, "unknown">, number> = {
  quarterly: 91,
  semiannual: 182,
  annual: 365,
};

function classifyGap(days: number): Cadence {
  // Snap to nearest anchor, but only within a tolerance window — a raw
  // gap of 250 days doesn't belong to either cadence; return "unknown".
  const withDistance: Array<{ c: Cadence; d: number }> = [
    { c: "quarterly", d: Math.abs(days - ANCHORS.quarterly) },
    { c: "semiannual", d: Math.abs(days - ANCHORS.semiannual) },
    { c: "annual", d: Math.abs(days - ANCHORS.annual) },
  ];
  withDistance.sort((a, b) => a.d - b.d);
  const best = withDistance[0];
  // Tolerance thresholds: half the distance to the next anchor, minus a
  // bit of slack. quarterly<->semiannual midpoint = 136.5; that's the
  // max distance a quarterly gap can be. Use 45 / 55 / 90 as forgiving
  // half-widths.
  const tolerance =
    best.c === "quarterly" ? 45 : best.c === "semiannual" ? 55 : 90;
  return best.d <= tolerance ? best.c : "unknown";
}

export interface EstimateInput {
  ticker: string;
  benchmark: string;
  pastEventDates: string[]; // ISO YYYY-MM-DD, any order
  // Latest reported fiscal-period label (e.g. "FY2025 Q3"). When
  // provided, the next-event label is derived by INCREMENTING this
  // along the entity's fiscal calendar — not by taking the calendar
  // quarter of the projected date. Fixes MSFT / AAPL / NVDA and every
  // other non-calendar-year filer, whose fiscal Q4 lands in a
  // different calendar quarter than the label suggests.
  latestPastPeriod?: string;
}

export interface EstimateOutput {
  ok: boolean;
  scheduledDate?: string; // ISO YYYY-MM-DD when ok
  period?: string; // FY{year} Q{q}
  cadence?: Cadence;
  medianGapDays?: number;
  reason?: string; // when ok is false
}

function periodFromDate(iso: string): { year: number; quarter: number } {
  const d = new Date(iso);
  return {
    year: d.getUTCFullYear(),
    quarter: Math.floor(d.getUTCMonth() / 3) + 1,
  };
}

// Step a fiscal-period label along the entity's own calendar. Quarterly
// +1 (wrapping Q4 → FY+1 Q1); semi-annual +2 (H1↔H2 within FY, wrap
// Q3→FY+1 Q1); annual +4 (same quarter next year). Preserves the
// fiscal-year offset the source-reported label carries.
export function incrementPeriod(label: string, cadence: Cadence): string | null {
  const m = /FY\s*(\d{4})\s+Q\s*(\d)/i.exec(label ?? "");
  if (!m) return null;
  let year = Number(m[1]);
  let q = Number(m[2]);
  const stepQ =
    cadence === "quarterly" ? 1 :
    cadence === "semiannual" ? 2 :
    cadence === "annual" ? 4 : 1;
  q += stepQ;
  while (q > 4) { q -= 4; year++; }
  return `FY${year} Q${q}`;
}

// Choose the modal cadence class from a list of per-gap classifications.
// "unknown" votes are counted but only win by strict majority — otherwise
// we tiebreak toward the most-frequent recognized class.
function modalCadence(classes: Cadence[]): Cadence {
  const counts = new Map<Cadence, number>();
  for (const c of classes) counts.set(c, (counts.get(c) ?? 0) + 1);
  const known = (["quarterly", "semiannual", "annual"] as const)
    .map((c) => ({ c, n: counts.get(c) ?? 0 }))
    .sort((a, b) => b.n - a.n);
  if (known[0].n === 0) return "unknown";
  return known[0].c;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[m - 1] + sorted[m]) / 2)
    : sorted[m];
}

export function estimateNextEvent(
  input: EstimateInput,
  now: Date = new Date(),
): EstimateOutput {
  const { pastEventDates } = input;
  if (pastEventDates.length < ESTIMATE_MIN_PAST_EVENTS) {
    return { ok: false, reason: "not enough past events" };
  }
  const sortedISO = pastEventDates.slice().sort();
  const latestPast = sortedISO[sortedISO.length - 1];
  const daysSinceLatest =
    (now.getTime() - new Date(latestPast).getTime()) / 86_400_000;
  if (daysSinceLatest > ESTIMATE_MAX_LOOKBACK_DAYS) {
    return {
      ok: false,
      reason: `last event ${Math.round(daysSinceLatest)}d ago — likely delisted`,
    };
  }
  const gaps: number[] = [];
  for (let i = 1; i < sortedISO.length; i++) {
    const gap =
      (new Date(sortedISO[i]).getTime() -
        new Date(sortedISO[i - 1]).getTime()) /
      86_400_000;
    // Widen from the old 400-day cap so annual filers (~365d) are
    // included. Tossing spurious duplicates (< 30d) and half-decade
    // outliers (> 500d) still keeps the classifier well-behaved.
    if (gap >= 30 && gap <= 500) gaps.push(gap);
  }
  if (gaps.length === 0) {
    return { ok: false, reason: "no valid consecutive gaps" };
  }
  const cadences = gaps.map(classifyGap);
  const cadence = modalCadence(cadences);
  if (cadence === "unknown") {
    return {
      ok: false,
      reason: `gaps ${gaps.map((g) => Math.round(g)).join(",")} don't cluster on any known cadence`,
      medianGapDays: median(gaps),
    };
  }
  // Project forward from the latest past event by the cadence anchor.
  // Anchor beats raw median: a semi-annual filer with one late Q1 in
  // the history shouldn't be projected 200 days out.
  const step = ANCHORS[cadence];
  const projected = new Date(latestPast);
  projected.setDate(projected.getDate() + step);
  // If the projection is already in the past (e.g., we're 200 days past
  // the latest event and cadence=semiannual), roll forward one more step.
  let daysAhead =
    (projected.getTime() - now.getTime()) / 86_400_000;
  let safety = 0;
  while (daysAhead < 0 && safety < 4) {
    projected.setDate(projected.getDate() + step);
    daysAhead =
      (projected.getTime() - now.getTime()) / 86_400_000;
    safety++;
  }
  const iso = projected.toISOString().slice(0, 10);
  // Derive the label by INCREMENTING the latest known period along the
  // entity's own fiscal cadence — never from the calendar quarter of the
  // projected date. MSFT's fiscal Q3 is calendar Q1; a next-quarter
  // projection lands in July but labels as "FY-year Q4", not "Q3".
  // Fall back to calendar-quarter derivation only when no source label
  // is available (rare — mostly SEC-submissions shells before the
  // first XBRL fill).
  let period: string;
  if (input.latestPastPeriod) {
    const stepped = incrementPeriod(input.latestPastPeriod, cadence);
    if (stepped) {
      period = stepped;
    } else {
      const { year, quarter } = periodFromDate(iso);
      period = `FY${year} Q${quarter}`;
    }
  } else {
    const { year, quarter } = periodFromDate(iso);
    period = `FY${year} Q${quarter}`;
  }
  return {
    ok: true,
    scheduledDate: iso,
    period,
    cadence,
    medianGapDays: median(gaps),
  };
}

// Collect past-event ISO dates per ticker from an EventRecord[] list.
export function collectPastDatesByTicker(
  events: EventRecord[],
): Map<string, string[]> {
  const byTicker = new Map<string, string[]>();
  for (const ev of events) {
    if (!ev.eventDate) continue;
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker)!.push(ev.eventDate);
  }
  return byTicker;
}
