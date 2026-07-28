// Daily self-check for the cron pipeline. Produces a structured report
// with unambiguous field names — `shard_files` and `tickers_with_past_events`
// are distinct (past bug: I once conflated them in a summary line).
//
// The regression rules below encode "the pipeline stayed healthy today":
// any drop in past/forward coverage, any leaked duplicate, any missing
// provenance / currency, or any vendor with a >20% error rate flips the
// status to "degraded" with a human-readable reason attached.
//
// Two artifacts produced per run:
//   - data/pipeline-report.json — latest snapshot (single object)
//   - data/pipeline-history.jsonl — append-only, one entry per day, used
//     by the health page sparkline

import type { EarningsSnapshot, Entity, EventsIndex } from "@/lib/types";

export interface VendorStats {
  attempted: number;
  succeeded: number;
  empty: number;
  errored: number;
}

export interface PipelineReport {
  schema: "pipeline-report/v2";
  date: string; // ISO YYYY-MM-DD
  finishedAt: string; // ISO datetime
  status: "ok" | "degraded";
  reasons: string[];
  // Corpus counts — every field named to survive future re-reads
  // without ambiguity.
  events_total: number;
  events_added_today: number;
  shard_files: number;
  tickers_with_past_events: number;
  tickers_with_forward_dates: number;
  // Precision partition — mutually exclusive; sum equals
  // `tickers_with_forward_dates`. Do not read `_within_30d` as a third
  // bucket in the same hierarchy; it's an orthogonal time-window filter.
  forward_dates_confirmed: number; // freshness !== "stale" (Yahoo/SEC-confirmed)
  forward_dates_estimated: number; // freshness === "stale" (median-gap projected)
  // Orthogonal time filter — count of forward-dated tickers whose
  // scheduledDate falls within the next 30 days. Overlaps freely with
  // both partition buckets above. Renamed from `_window` to make the
  // dimension explicit and prevent additive misreads.
  forward_dates_within_30d: number;
  // Quality gates — non-zero means a rule leaked.
  duplicates_detected: number;
  events_missing_provenance: number;
  metrics_missing_currency: number;
  shard_index_mismatches: number;
  // Reaction maturation counters (schema v2). Sum across every event's
  // reaction.points[]. `computed` = points where absReturn !== null (matured
  // or clipped). `pending` = points where absReturn === null AND populatesOn
  // has already elapsed (should be small — a large number here means
  // matureEventReaction is failing quietly).
  reactions_computed: number;
  reactions_pending: number;
  // Terminal decay counter (Part 6 of entity-dedup work). Points that
  // will never mature — flipped to status:"unavailable" by
  // scripts/apply-reaction-decay.mjs or the cron maturation step when
  // the event is >60 trading days past and bars still don't exist.
  reactions_unavailable: number;
  // Company grouping counters (Part 4 of entity-dedup work).
  // `companies_total` = distinct companyId count. `entities_unassigned`
  // = entities missing a companyId (should be 0 after the Part-2 apply
  // + Part-4 cron wiring; a non-zero here means a new entity slipped
  // in without going through the assignment step).
  companies_total: number;
  entities_unassigned: number;
  // Per-vendor call counters. Increment during the cron run; drives the
  // >20% error-rate regression rule.
  per_vendor: {
    yahoo_qs: VendorStats;
    yahoo_ts: VendorStats;
    sec: VendorStats;
    fmp: VendorStats;
  };
  cron_duration_ms: number;
}

// One-line-per-day rollup for pipeline-history.jsonl. Small on purpose —
// the sparkline only needs three columns; keep it under 200 bytes/line so
// years of history stays a KB-scale file.
export interface PipelineHistoryEntry {
  date: string;
  events_total: number;
  tickers_with_past_events: number;
  tickers_with_forward_dates: number;
  forward_dates_estimated: number;
  duplicates_detected: number;
  status: "ok" | "degraded";
  // Included for the Part-6 "reactions_pending growing without new events"
  // regression check. Optional so older history entries (pre-decay work)
  // parse cleanly — the growth rule skips when either side is undefined.
  reactions_pending?: number;
}

const CLOSE_DAYS = 45;

function daysBetween(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

// Count duplicates using the same rules as scripts/detect-duplicate-events.mjs:
// (1) two events sharing a fiscal period, (2) two events with report dates
// <=45d apart on the same ticker with the same fiscal year. Same-year check
// avoids flagging real quarterly boundaries (Q4/Q1 in adjacent months).
export function countDuplicates(snap: EarningsSnapshot): number {
  const byTicker = new Map<string, typeof snap.events>();
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker)!.push(ev);
  }
  let dupes = 0;
  for (const [, past] of byTicker) {
    const byPeriod = new Map<string, number>();
    for (const ev of past) {
      byPeriod.set(ev.period ?? "", (byPeriod.get(ev.period ?? "") ?? 0) + 1);
    }
    for (const [, n] of byPeriod) if (n > 1) dupes += n - 1;

    const sorted = past.slice().sort((a, b) =>
      (a.eventDate ?? "").localeCompare(b.eventDate ?? ""),
    );
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      if (a.period === b.period) continue; // already counted
      if (daysBetween(a.eventDate!, b.eventDate!) > CLOSE_DAYS) continue;
      const yearA = (a.period ?? "").match(/FY(\d{4})/)?.[1];
      const yearB = (b.period ?? "").match(/FY(\d{4})/)?.[1];
      if (yearA && yearB && yearA !== yearB) continue;
      dupes++;
    }
  }
  return dupes;
}

// Corpus-wide quality counts. Events with no provenance stamp; metric
// actuals whose unit doesn't look like a valid currency code. Both should
// be zero after the July-2026 provenance + currency-labeling passes.
export function countCorpusQualityGaps(snap: EarningsSnapshot): {
  events_missing_provenance: number;
  metrics_missing_currency: number;
} {
  let missingProv = 0;
  let missingCurrency = 0;
  for (const ev of snap.events) {
    if (!ev.provenance) missingProv++;
    for (const m of ev.metrics ?? []) {
      const unit = m.actual?.unit;
      if (m.actual?.value == null) continue;
      // A currency-bearing metric key (revenue_usd_m, eps_usd, etc.) with
      // an actual value must carry an ISO-3 currency code (optionally
      // suffixed with _m for millions).
      const isCurrencyMetric = /^(revenue_|eps_|ebitda_|adj_ebitda_|net_income_|gross_profit_|operating_income_|dr_eps_)/.test(m.key);
      if (isCurrencyMetric && !/^[A-Z]{3}(_m)?$/.test(unit ?? "")) {
        missingCurrency++;
      }
    }
  }
  return { events_missing_provenance: missingProv, metrics_missing_currency: missingCurrency };
}

// Cross-check the events-index against the reconstituted snapshot. Any
// ticker whose index-side `count` disagrees with the shard-side count is
// an index-drift bug — the writer skipped a rebuild.
export function countIndexMismatches(
  index: EventsIndex,
  snap: EarningsSnapshot,
): number {
  const shardCounts = new Map<string, number>();
  for (const ev of snap.events) {
    shardCounts.set(ev.ticker, (shardCounts.get(ev.ticker) ?? 0) + 1);
  }
  let mism = 0;
  for (const entry of index.entries) {
    const shardCount = shardCounts.get(entry.ticker) ?? 0;
    if (shardCount !== entry.count) mism++;
  }
  return mism;
}

// Bucket per-ticker forward-date coverage.
// Partition (mutually exclusive): confirmed = freshness !== "stale",
// estimated = freshness === "stale". Their sum equals
// `tickers_with_forward_dates`. `_within_30d` is a separate orthogonal
// dimension counting any forward-dated ticker whose scheduledDate falls
// in the next 30 days; it overlaps with both partition buckets.
export function bucketForwardCoverage(
  snap: EarningsSnapshot,
  today: Date = new Date(),
): {
  tickers_with_forward_dates: number;
  forward_dates_confirmed: number;
  forward_dates_estimated: number;
  forward_dates_within_30d: number;
} {
  const seen = new Set<string>();
  let confirmed = 0;
  let estimated = 0;
  let inWindow = 0;
  const todayIso = today.toISOString().slice(0, 10);
  const thirtyDaysAhead = new Date(today);
  thirtyDaysAhead.setDate(thirtyDaysAhead.getDate() + 30);
  const windowEnd = thirtyDaysAhead.toISOString().slice(0, 10);

  for (const ev of snap.events) {
    if (ev.eventDate) continue; // past
    if (seen.has(ev.ticker)) continue;
    seen.add(ev.ticker);
    if (ev.freshness === "stale") estimated++;
    else confirmed++;
    if (
      ev.scheduledDate &&
      ev.scheduledDate >= todayIso &&
      ev.scheduledDate <= windowEnd
    ) {
      inWindow++;
    }
  }
  return {
    tickers_with_forward_dates: seen.size,
    forward_dates_confirmed: confirmed,
    forward_dates_estimated: estimated,
    forward_dates_within_30d: inWindow,
  };
}

export interface ComputeReportInput {
  snap: EarningsSnapshot;
  index: EventsIndex;
  // Registry — used to derive companies_total + entities_unassigned.
  // Optional so older cron callers that don't pass it still work; they
  // get 0 for both fields (would flag as degraded once we add rules).
  entities?: Entity[];
  shardFileCount: number;
  eventsAddedToday: number;
  perVendor: PipelineReport["per_vendor"];
  cronDurationMs: number;
  startedAt: Date;
  finishedAt: Date;
}

export function computePipelineReport(input: ComputeReportInput): PipelineReport {
  const {
    snap,
    index,
    entities,
    shardFileCount,
    eventsAddedToday,
    perVendor,
    cronDurationMs,
    finishedAt,
  } = input;
  const tickersWithPast = new Set<string>();
  for (const ev of snap.events) if (ev.eventDate) tickersWithPast.add(ev.ticker);
  const forward = bucketForwardCoverage(snap, finishedAt);
  const quality = countCorpusQualityGaps(snap);
  const dupes = countDuplicates(snap);
  const mism = countIndexMismatches(index, snap);
  // Reaction maturation counters — sum across all events' reaction.points.
  let reactionsComputed = 0;
  let reactionsPending = 0;
  let reactionsUnavailable = 0;
  const todayIso = finishedAt.toISOString().slice(0, 10);
  for (const ev of snap.events) {
    for (const p of ev.reaction?.points ?? []) {
      if (p.status === "unavailable") {
        reactionsUnavailable++;
      } else if (p.absReturn !== null && p.absReturn !== undefined) {
        reactionsComputed++;
      } else if (
        p.populatesOn &&
        p.populatesOn <= todayIso
      ) {
        reactionsPending++;
      }
    }
  }
  // Company grouping (Part 4). Distinct companyId across the registry.
  // entities_unassigned = entities missing a companyId (invariant: 0 after
  // Part 2's apply + Part 4's cron wiring).
  const companyIds = new Set<string>();
  let entitiesUnassigned = 0;
  if (entities) {
    for (const e of entities) {
      if (e.companyId) companyIds.add(e.companyId);
      else entitiesUnassigned++;
    }
  }
  return {
    schema: "pipeline-report/v2",
    date: finishedAt.toISOString().slice(0, 10),
    finishedAt: finishedAt.toISOString(),
    status: "ok", // updated by checkRegressions
    reasons: [],
    events_total: snap.events.length,
    events_added_today: eventsAddedToday,
    shard_files: shardFileCount,
    tickers_with_past_events: tickersWithPast.size,
    ...forward,
    duplicates_detected: dupes,
    events_missing_provenance: quality.events_missing_provenance,
    metrics_missing_currency: quality.metrics_missing_currency,
    shard_index_mismatches: mism,
    reactions_computed: reactionsComputed,
    reactions_pending: reactionsPending,
    reactions_unavailable: reactionsUnavailable,
    companies_total: companyIds.size,
    entities_unassigned: entitiesUnassigned,
    per_vendor: perVendor,
    cron_duration_ms: cronDurationMs,
  };
}

// Apply the regression rules; returns a new report with status +/- reasons.
// Passes `prev` (yesterday's snapshot) for drop-detection; if null (first
// run), the drop rules skip. `calendarExpected` is a hook for the future
// calendar.json signal — null means "no expectation encoded, skip that rule".
export function checkRegressions(
  current: PipelineReport,
  prev: PipelineHistoryEntry | null,
  calendarExpected: boolean | null,
  weekday: number = new Date(current.date).getUTCDay(),
): PipelineReport {
  const reasons: string[] = [];

  // events_added_today == 0 on a weekday when calendar expected reports
  const isWeekday = weekday >= 1 && weekday <= 5;
  if (isWeekday && calendarExpected === true && current.events_added_today === 0) {
    reasons.push("no events added on a weekday when calendar expected reports");
  }

  // Coverage drops vs yesterday
  if (prev) {
    if (current.tickers_with_past_events < prev.tickers_with_past_events) {
      reasons.push(
        `tickers_with_past_events dropped ${prev.tickers_with_past_events}→${current.tickers_with_past_events}`,
      );
    }
    if (current.tickers_with_forward_dates < prev.tickers_with_forward_dates) {
      reasons.push(
        `tickers_with_forward_dates dropped ${prev.tickers_with_forward_dates}→${current.tickers_with_forward_dates}`,
      );
    }
  }

  if (current.duplicates_detected > 0) {
    reasons.push(`duplicates_detected=${current.duplicates_detected} — dedup rule leaked`);
  }
  if (current.events_missing_provenance > 0) {
    reasons.push(`events_missing_provenance=${current.events_missing_provenance}`);
  }
  if (current.metrics_missing_currency > 0) {
    reasons.push(`metrics_missing_currency=${current.metrics_missing_currency}`);
  }
  if (current.shard_index_mismatches > 0) {
    reasons.push(`shard_index_mismatches=${current.shard_index_mismatches}`);
  }
  if (current.entities_unassigned > 0) {
    reasons.push(
      `entities_unassigned=${current.entities_unassigned} — companyId assignment leaked`,
    );
  }

  // Part 6: reactions_pending growing without new events. If yesterday
  // had a pending count and today's is strictly higher, but events_total
  // did not grow, the decay job is falling behind (or matureEventReaction
  // is failing quietly on live tickers). Only fire when both sides carry
  // the field — older history entries have it undefined.
  if (
    prev &&
    typeof prev.reactions_pending === "number" &&
    typeof current.reactions_pending === "number" &&
    current.reactions_pending > prev.reactions_pending &&
    current.events_total <= prev.events_total
  ) {
    reasons.push(
      `reactions_pending growing without new events (${prev.reactions_pending}→${current.reactions_pending})`,
    );
  }

  // Vendor error rates >20% on non-empty attempt counts
  for (const [name, v] of Object.entries(current.per_vendor)) {
    if (v.attempted > 0 && v.errored / v.attempted > 0.2) {
      reasons.push(
        `${name} errored on ${v.errored}/${v.attempted} attempts (>20%)`,
      );
    }
  }

  return {
    ...current,
    status: reasons.length === 0 ? "ok" : "degraded",
    reasons,
  };
}

export function toHistoryEntry(report: PipelineReport): PipelineHistoryEntry {
  return {
    date: report.date,
    events_total: report.events_total,
    tickers_with_past_events: report.tickers_with_past_events,
    tickers_with_forward_dates: report.tickers_with_forward_dates,
    forward_dates_estimated: report.forward_dates_estimated,
    duplicates_detected: report.duplicates_detected,
    status: report.status,
    reactions_pending: report.reactions_pending,
  };
}

export function emptyVendorStats(): PipelineReport["per_vendor"] {
  const s = (): VendorStats => ({ attempted: 0, succeeded: 0, empty: 0, errored: 0 });
  return { yahoo_qs: s(), yahoo_ts: s(), sec: s(), fmp: s() };
}
