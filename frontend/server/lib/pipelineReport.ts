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
  schema: "pipeline-report/v3";
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
  // v3: informational sibling of duplicates_detected. Counts events
  // <=45d apart with DIFFERENT fiscal labels but same FY — the
  // fiscal-offset canary from CLAUDE.md. NOT degrade-triggering: it
  // may indicate a labelling bug (fixed on the ticker's shard) or a
  // legit close-packed filing (10-K + 10-Q dance around fiscal year
  // end). Surface to eyeball, don't flip status.
  duplicates_close_date_fiscal_canary: number;
  duplicates_close_date_samples: string[];
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
  // scripts/backfills/apply-reaction-decay.mjs or the cron maturation step when
  // the event is >60 trading days past and bars still don't exist.
  reactions_unavailable: number;
  // Company grouping counters (Part 4 of entity-dedup work).
  // `companies_total` = distinct companyId count. `entities_unassigned`
  // = entities missing a companyId (should be 0 after the Part-2 apply
  // + Part-4 cron wiring; a non-zero here means a new entity slipped
  // in without going through the assignment step).
  companies_total: number;
  entities_unassigned: number;
  // Cross-listing revenue consistency invariant. Every listing of a
  // single company must show the same headline revenue for the same
  // fiscal period — Alphabet's four listings each storing a different
  // Q2 2026 revenue was the exact symptom that surfaced in the July-
  // 2026 financials audit. This counter catches that bug class WITHOUT
  // needing an external source (SEC XBRL); a non-zero value flags
  // degraded and lists a sample of affected companies in reasons[].
  companies_with_inconsistent_financials: number;
  companies_with_inconsistent_financials_samples: string[];
  // Phase 4 · absolute report-attachment rule (SP500 spec, applies
  // universe-wide): a past event with real actuals but no filing
  // sourceLink is a bug by definition. NO GRACE WINDOW. Degrade rule:
  // reported_without_document > 0.
  reported_without_document: number;
  reported_without_document_samples: string[];
  // v3.1: structural counterpart — CIK-less entities whose actuals
  // came from Yahoo but where SEC attachment can't apply. Not
  // degradation-triggering (would need hand-mapped IR PDFs to close).
  reported_without_document_structural: number;
  // Phase 4 · SP500 completeness canary. Percentage of the ~503
  // members' latest reported quarter that clears all four layers
  // (results + document + estimates + reaction). Degrade rule:
  // sp500_complete_pct < 98%.
  sp500_complete_pct: number;
  // Companion informational counter (v3): same company, different
  // reporting currencies across listings. STRUCTURAL, not a bug —
  // Deutsche Telekom's BR-BDR reports in BRL; Telenor's US ADR
  // reports in USD; the primary in each pair reports in EUR/NOK.
  // Not degradation-triggering; visible on the health page so the
  // condition is auditable, not hidden.
  companies_with_fx_mismatch: number;
  companies_with_fx_mismatch_samples: string[];
  // Freshness classification (v3). Sourced by the standing detector
  // (detect-stale-earnings logic) folded into every report run. FRESH
  // means the ticker's latest past event covers the most recent
  // expected period. STALE means the expected report has come and
  // gone but no past event exists — this is the decay signal. Rule:
  // stale > 10 flips status to degraded (a handful of legit same-day
  // reporters shouldn't; systemic ingest failure will).
  freshness: {
    fresh: number;
    stale: number;
    shell_only: number;
    no_history: number;
    unknown: number;
    fresh_pct: number;
  };
  // Sweep 1: estimator label conflict count. A forward-dated shell must
  // carry a period STRICTLY AFTER the ticker's latest reported period,
  // stepped along the entity's own fiscal calendar. Non-zero here
  // means the label-increment logic in estimateNextEvent.ts regressed;
  // MSFT / AAPL / NVDA-class fiscal-offset filers are the canary.
  estimator_label_conflicts: number;
  // Part 5c: market-cap staleness across canonical listings. Sector +
  // search views both order by marketCapUsd descending; a stale cap
  // silently corrupts both orderings, so count entities whose cap
  // hasn't been refreshed in 7+ days. Degraded if >10% of canonicals
  // are stale — see checkRegressions.
  marketcap_stale_count: number;
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

// Count duplicates using the same rules as scripts/backfills/detect-duplicate-events.mjs:
// (1) two events sharing a fiscal period, (2) two events with report dates
// <=45d apart on the same ticker with the same fiscal year. Same-year check
// avoids flagging real quarterly boundaries (Q4/Q1 in adjacent months).
//
// Skips dormant tickers — those are frozen registry entries whose historical
// data doesn't get maintained. Duplicates on them are the state we found
// them in; counting them just floods the counter with noise (ALD/CXA US
// dormants were dominating the 2026-07-31 report's 16-count).
// v3 split: two kinds of "duplicate":
//   same_period_dupes → same fiscal-period label present >1 time on a
//     ticker. This is unambiguously a dedup-rule leak; must be zero.
//     Flips status to degraded.
//   close_date_fiscal_canary → two events <=45d apart with DIFFERENT
//     labels but the same FY. This is the CLAUDE.md-documented fiscal-
//     offset canary: it MAY be a labelling bug or MAY be a legit close-
//     packed cross-listing filing (e.g. AR annual + Q4). Informational
//     only — we surface it to eyeball but no longer degrade.
// The wrapper preserves the old single-number API by returning the sum
// on `.total`; new callers should read `.same_period` for the degraded
// flag and `.close_date` for the informational counter.
export function countDuplicates(
  snap: EarningsSnapshot,
  dormant: Set<string> = new Set(),
): { total: number; same_period: number; close_date: number; close_date_samples: string[] } {
  const byTicker = new Map<string, typeof snap.events>();
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    if (dormant.has(ev.ticker)) continue;
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker)!.push(ev);
  }
  let samePeriod = 0;
  let closeDate = 0;
  const closeDateSamples: string[] = [];
  for (const [ticker, past] of byTicker) {
    const byPeriod = new Map<string, number>();
    for (const ev of past) {
      byPeriod.set(ev.period ?? "", (byPeriod.get(ev.period ?? "") ?? 0) + 1);
    }
    for (const [, n] of byPeriod) if (n > 1) samePeriod += n - 1;

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
      closeDate++;
      if (closeDateSamples.length < 5) closeDateSamples.push(ticker);
    }
  }
  return {
    total: samePeriod + closeDate,
    same_period: samePeriod,
    close_date: closeDate,
    close_date_samples: closeDateSamples,
  };
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
      // Accept currency-only forms (USD, EUR_m, CAD) AND EPS
      // per-share forms (USD/shares, DKK/shares) — SEC XBRL reports
      // basic/diluted EPS with the /shares suffix and the unit-
      // inheritance rederive keeps SEC's label verbatim. Also accept
      // sub-unit codes ZAc (South African cents), GBp (British
      // pence), ILA (Israeli agora) — Yahoo/SEC report AngloGold
      // Ashanti in ZAc, UK-listed dual-classes in GBp. These are
      // valid currency units, just not the strict ISO-3 uppercase
      // form. Pattern: [Aa-z]{3} with an uppercase-then-lowercase
      // shape catches the sub-unit codes without matching random
      // lowercase strings.
      const isValidCurrencyUnit =
        /^[A-Z]{3}(_m)?$/.test(unit ?? "") ||
        /^[A-Z]{3}\/shares$/.test(unit ?? "") ||
        /^[A-Z]{2}[a-z]$/.test(unit ?? "");
      if (isCurrencyMetric && !isValidCurrencyUnit) {
        missingCurrency++;
      }
    }
  }
  return { events_missing_provenance: missingProv, metrics_missing_currency: missingCurrency };
}

// Cross-listing revenue consistency check (audit-prompt follow-up).
// Every listing of a single company must show the same headline
// revenue for the same fiscal period. Returns the count of companies
// with any inconsistency + a sample of up to 5 for reasons[].
//
// Tolerance is 0.5% — same threshold as the "match" bucket in
// scripts/backfills/verify-financials.mjs. Prevents false positives from
// currency rounding across ADR mirror listings.
export function checkCrossListingConsistency(
  snap: EarningsSnapshot,
  entities: Entity[],
): {
  same_currency_count: number;
  same_currency_samples: string[];
  fx_mismatch_count: number;
  fx_mismatch_samples: string[];
} {
  const companyByTicker = new Map<string, string>();
  for (const e of entities) {
    if (e.companyId) companyByTicker.set(e.ticker, e.companyId);
  }
  // group[companyId][period] = { tickers, values, units }
  const groups = new Map<
    string,
    Map<string, { tickers: string[]; values: number[]; units: string[] }>
  >();
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    const cid = companyByTicker.get(ev.ticker);
    if (!cid) continue;
    const revenue = ev.metrics?.find((m) => /^revenue_/i.test(m.key ?? ""))?.actual;
    if (revenue?.value == null) continue;
    const key = ev.period ?? "";
    if (!groups.has(cid)) groups.set(cid, new Map());
    const perCo = groups.get(cid)!;
    if (!perCo.has(key)) perCo.set(key, { tickers: [], values: [], units: [] });
    const cell = perCo.get(key)!;
    cell.tickers.push(ev.ticker);
    cell.values.push(revenue.value);
    cell.units.push(revenue.unit ?? "");
  }
  // Split into two buckets:
  //   - fx_mismatch = same company, different currency units — structural
  //     (Deutsche Telekom's BR-BDR in BRL vs primary in EUR; Telenor's NO
  //     listing in NOK vs US ADR in USD). Not a bug, just FX. Informational.
  //   - same_currency = same company, SAME currency, values still >0.5%
  //     apart — a real ingest inconsistency. Actionable/degraded.
  const fxBad = new Set<string>();
  const fxSamples: string[] = [];
  const sameCurBad = new Set<string>();
  const sameCurSamples: string[] = [];
  for (const [cid, perCo] of groups) {
    for (const [period, cell] of perCo) {
      if (cell.values.length < 2) continue;
      const min = Math.min(...cell.values);
      const max = Math.max(...cell.values);
      const denom = Math.max(Math.abs(max), 1e-9);
      const spread = ((max - min) / denom) * 100;
      if (spread <= 0.5) continue;
      const uniqUnits = new Set(cell.units);
      if (uniqUnits.size > 1) {
        fxBad.add(cid);
        if (fxSamples.length < 5) {
          const pairs = cell.tickers
            .map((t, i) => `${t}=${cell.values[i].toFixed(0)} ${cell.units[i]}`)
            .join(", ");
          fxSamples.push(`${cid} · ${period} · ${pairs}`);
        }
      } else {
        sameCurBad.add(cid);
        if (sameCurSamples.length < 5) {
          sameCurSamples.push(
            `${cid} · ${period} · ${cell.tickers.join("/")} · spread=${spread.toFixed(1)}% (${min.toFixed(1)}–${max.toFixed(1)} ${[...uniqUnits][0]})`,
          );
        }
      }
    }
  }
  return {
    same_currency_count: sameCurBad.size,
    same_currency_samples: sameCurSamples,
    fx_mismatch_count: fxBad.size,
    fx_mismatch_samples: fxSamples,
  };
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

// Freshness classifier — mirrors the standalone logic in
// scripts/detect-stale-earnings.mjs so every pipeline-report run
// emits a current five-class distribution. The detector runs
// locally, no network, so folding it into the report is cheap.
// STALE_THRESHOLD_DAYS = 7 keeps parity with the detector.
function classifyFreshness(
  snap: EarningsSnapshot,
  entities: Entity[] | undefined,
  dormant: Set<string>,
  now: Date,
): {
  fresh: number;
  stale: number;
  shell_only: number;
  no_history: number;
  unknown: number;
  fresh_pct: number;
} {
  const STALE_THRESHOLD = 7;
  const operating = (entities ?? []).filter(
    (e) => e.securityType === "operating" && !dormant.has(e.ticker),
  );
  const byTicker = new Map<string, EarningsSnapshot["events"]>();
  for (const ev of snap.events) {
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker)!.push(ev);
  }
  function nextQuarter(period: string | null | undefined): string | null {
    const m = /^FY(\d{4})\s*Q([1-4])$/.exec(period ?? "");
    if (!m) return null;
    const y = Number(m[1]);
    const q = Number(m[2]);
    return q === 4 ? `FY${y + 1} Q1` : `FY${y} Q${q + 1}`;
  }
  function median(nums: number[]): number | null {
    if (nums.length < 2) return null;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  }
  let fresh = 0, stale = 0, shell_only = 0, no_history = 0, unknown = 0;
  const nowTs = now.getTime();
  for (const entity of operating) {
    const evs = byTicker.get(entity.ticker) ?? [];
    const past = evs
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
    const upcoming = evs
      .filter((e) => !e.eventDate)
      .sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
    if (past.length === 0) { no_history++; continue; }
    const pastReal = past.filter((e) => (e.metrics ?? []).some((m) => m.actual?.value != null));
    const latestPast = past[0];
    const shellOnly = !((latestPast.metrics ?? []).some((m) => m.actual?.value != null));
    if (shellOnly) { shell_only++; continue; }
    // Cadence-based expected next report; fall back to upcoming shell's
    // scheduledDate for fiscal-offset issuers whose cadence is uneven.
    const dates = (pastReal.length >= 2 ? pastReal : past)
      .map((e) => e.eventDate!)
      .sort();
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86_400_000);
    }
    const cadence = median(gaps);
    const anchorPast = pastReal[0]?.eventDate ?? latestPast.eventDate ?? null;
    if (!cadence || !anchorPast) { unknown++; continue; }
    const shellIso = upcoming[0]?.scheduledDate ?? null;
    const cadenceProjectedIso = new Date(
      Date.parse(anchorPast) + cadence * 86_400_000,
    ).toISOString().slice(0, 10);
    const expectedIso = shellIso ?? cadenceProjectedIso;
    const expectedPeriod = upcoming[0]?.period ?? nextQuarter(latestPast.period);
    const daysPast = Math.floor(
      (nowTs - Date.parse(expectedIso)) / 86_400_000,
    );
    const alreadyHaveExpected =
      expectedPeriod && pastReal.some((e) => e.period === expectedPeriod);
    if (alreadyHaveExpected || daysPast < STALE_THRESHOLD) fresh++;
    else stale++;
  }
  const total = fresh + stale + shell_only + no_history + unknown;
  const fresh_pct = total > 0 ? Number(((fresh / total) * 100).toFixed(1)) : 0;
  return { fresh, stale, shell_only, no_history, unknown, fresh_pct };
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
  // Dormant tickers get excluded from the duplicate count — their
  // shard data is frozen registry state, not maintained, so any
  // period-dupes there are the state we found them in, not a fresh
  // ingest leak. Post-2026-07-31 dormant-flag: 4/5 of 2026-07-31's
  // duplicates were ALD/CXA US, both marked dormant hours earlier.
  const dormant = new Set<string>();
  if (entities) {
    for (const e of entities) {
      if ((e as Entity & { dormant?: boolean }).dormant) dormant.add(e.ticker);
    }
  }
  const dupes = countDuplicates(snap, dormant);
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
  // Cross-listing revenue consistency invariant. Detects the multi-
  // listing drift the July-2026 financials audit surfaced (Alphabet's
  // four listings storing four different Q2 revenue values). Only
  // runnable when we have the registry (needs companyId lookup).
  const crossListing = entities
    ? checkCrossListingConsistency(snap, entities)
    : {
        same_currency_count: 0,
        same_currency_samples: [],
        fx_mismatch_count: 0,
        fx_mismatch_samples: [],
      };
  // Freshness classification (v3). Same shape as
  // scripts/detect-stale-earnings.mjs' output, kept in sync here so
  // every pipeline-report run emits current freshness numbers
  // without a separate script call. FRESH = latest past covers
  // most-recent expected period. STALE = expected date >7 days past
  // with no matching event.
  const freshness = classifyFreshness(snap, entities, dormant, finishedAt);
  // Market-cap staleness (Part 5c). Count canonical entities whose
  // marketCapAsOf is >7 days old. Non-canonicals are omitted — they
  // don't drive the ordering.
  let marketcapStale = 0;
  let canonicalTotal = 0;
  const staleThresholdIso = new Date(
    finishedAt.getTime() - 7 * 86_400_000,
  ).toISOString().slice(0, 10);
  if (entities) {
    for (const e of entities) {
      if (!e.isCanonical) continue;
      canonicalTotal++;
      const asOf = e.marketCapAsOf ?? "";
      if (!asOf || asOf < staleThresholdIso) marketcapStale++;
    }
  }

  // Estimator label conflicts (Sweep 1). Per-ticker: latest reported
  // period vs each forward shell's period. Violations = shells labelled
  // at or before the latest reported period.
  let estimatorLabelConflicts = 0;
  const latestPeriodByTicker = new Map<string, string>();
  const latestDateByTicker = new Map<string, string>();
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    const prev = latestDateByTicker.get(ev.ticker);
    if (!prev || ev.eventDate > prev) {
      latestDateByTicker.set(ev.ticker, ev.eventDate);
      if (ev.period) latestPeriodByTicker.set(ev.ticker, ev.period);
    }
  }
  const parsePeriod = (label: string | undefined) => {
    const m = /FY\s*(\d{4})\s+Q\s*(\d)/i.exec(label ?? "");
    return m ? Number(m[1]) * 4 + Number(m[2]) : null;
  };
  for (const ev of snap.events) {
    if (ev.eventDate) continue;
    const latest = latestPeriodByTicker.get(ev.ticker);
    if (!latest) continue;
    const a = parsePeriod(ev.period);
    const b = parsePeriod(latest);
    if (a != null && b != null && a <= b) estimatorLabelConflicts++;
  }

  // Phase 4 · reported_without_document. Split into two buckets so
  // the counter is honest about which violations are actual bugs
  // vs structural data-source limits:
  //   SOLVABLE   — entity has an edgarCik → SEC filing path exists →
  //                a missing filing sourceLink is our pipe's bug.
  //                Degradation-triggering.
  //   STRUCTURAL — entity has no edgarCik (non-SEC filer: foreign
  //                primary, Canadian-only, pink sheet, etc.) → the
  //                SEC attachment path can't apply. Informational
  //                only; would need hand-mapped IR PDF or foreign
  //                regulator crawl to close, and those aren't a
  //                pipeline bug per se.
  const entityCikByTicker = new Map<string, string | null | undefined>();
  const entityFilerTypeByTicker = new Map<string, string | undefined>();
  if (entities) {
    for (const e of entities) {
      entityCikByTicker.set(e.ticker, e.edgarCik ?? null);
      entityFilerTypeByTicker.set(
        e.ticker,
        (e as Entity & { secFilerType?: string }).secFilerType,
      );
    }
  }
  let reportedWithoutDocument = 0;
  let reportedWithoutDocumentStructural = 0;
  const reportedWithoutDocumentSamples: string[] = [];
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    const hasActuals = (ev.metrics ?? []).some(
      (m) => m.actual?.value != null,
    );
    if (!hasActuals) continue;
    const link = ev.sourceLink;
    const ok =
      link &&
      link.kind === "filing" &&
      link.url &&
      !/google\.com\/search/i.test(link.url);
    if (ok) continue;
    const cik = entityCikByTicker.get(ev.ticker);
    const filerType = entityFilerTypeByTicker.get(ev.ticker);
    // "Solvable" = CIK IS on the entity AND the ticker is a US-primary
    // listing AND the entity is NOT flagged as a foreign filer.
    // Foreign filers (secFilerType === "foreign") have a CIK but file
    // via 20-F/40-F/6-K only — their document rule follows the home
    // venue (irSources), not SEC 10-Q. Marked by
    // scripts/apply-sec-filer-type.mjs from the triage classifier.
    if (
      cik &&
      ev.ticker.endsWith(" US") &&
      filerType !== "foreign" &&
      filerType !== "pre-listing"
    ) {
      reportedWithoutDocument++;
      if (reportedWithoutDocumentSamples.length < 8) {
        reportedWithoutDocumentSamples.push(`${ev.ticker} · ${ev.period ?? "?"}`);
      }
    } else {
      reportedWithoutDocumentStructural++;
    }
  }

  // Phase 4 · sp500_complete_pct. Fraction of SP500 members whose
  // LATEST past event clears all four layers (results with real
  // date, document filing, estimates + surprise on same basis,
  // reaction points all populated). No entities → 0.
  let sp500LatestComplete = 0;
  let sp500LatestTotal = 0;
  const sp500Set = new Set<string>();
  if (entities) {
    for (const e of entities) {
      if ((e.index_membership ?? []).includes("SP500")) sp500Set.add(e.ticker);
    }
  }
  if (sp500Set.size > 0) {
    const latestByTicker = new Map<string, typeof snap.events[number]>();
    for (const ev of snap.events) {
      if (!ev.eventDate || !sp500Set.has(ev.ticker)) continue;
      const cur = latestByTicker.get(ev.ticker);
      if (!cur || (cur.eventDate ?? "") < (ev.eventDate ?? "")) {
        latestByTicker.set(ev.ticker, ev);
      }
    }
    for (const ev of latestByTicker.values()) {
      sp500LatestTotal++;
      const hasReal =
        ev.eventDate &&
        (ev.metrics ?? []).some((m) => m.actual?.value != null);
      const link = ev.sourceLink;
      const docOk =
        link && link.kind === "filing" && link.url && !/google\.com\/search/i.test(link.url);
      // Yahoo's earningsChart carries retroactive EPS estimates but
      // NOT revenue estimates — earningsTrend only fills the current +
      // next quarter, so past-quarter revenue estimates are
      // structurally unavailable at our data-source layer. Accept EPS
      // estimate presence as the estimates-layer floor; revenue
      // estimates on past events are a bonus. (The prompt spec's
      // "source had no estimate for this period" exclusion covers
      // this class explicitly.)
      const epsEst = (ev.metrics ?? []).find(
        (m) => /^eps/.test(m.key) && m.estimate?.value != null,
      );
      const estOk = !!epsEst;
      const points = ev.reaction?.points ?? [];
      const horizons = new Set(points.map((p) => p.horizon));
      // Horizon elapsed thresholds (calendar days from eventDate):
      // d1=2, d3=5, w1=8, m1=30. A pending point on a horizon that
      // hasn't elapsed yet is legitimate (in-progress, not gap).
      const daysSinceEvent = ev.eventDate
        ? (Date.now() - new Date(ev.eventDate).getTime()) / 86_400_000
        : Infinity;
      const HORIZON_MIN_DAYS: Record<string, number> = {
        d1: 2, d3: 5, w1: 8, m1: 30,
      };
      const rxnOk =
        (["d1", "d3", "w1", "m1"] as const).every((h) => horizons.has(h)) &&
        points.every((p) => {
          if (p.absReturn != null) return true;
          if (p.status === "clipped") return true;
          const min = HORIZON_MIN_DAYS[p.horizon] ?? 30;
          return daysSinceEvent < min; // pending is legit before elapse
        });
      if (hasReal && docOk && estOk && rxnOk) sp500LatestComplete++;
    }
  }
  const sp500CompletePct =
    sp500LatestTotal > 0
      ? Math.round((sp500LatestComplete / sp500LatestTotal) * 1000) / 10
      : 0;

  return {
    schema: "pipeline-report/v3",
    date: finishedAt.toISOString().slice(0, 10),
    finishedAt: finishedAt.toISOString(),
    status: "ok", // updated by checkRegressions
    reasons: [],
    events_total: snap.events.length,
    events_added_today: eventsAddedToday,
    shard_files: shardFileCount,
    tickers_with_past_events: tickersWithPast.size,
    ...forward,
    duplicates_detected: dupes.same_period,
    duplicates_close_date_fiscal_canary: dupes.close_date,
    duplicates_close_date_samples: dupes.close_date_samples,
    events_missing_provenance: quality.events_missing_provenance,
    metrics_missing_currency: quality.metrics_missing_currency,
    shard_index_mismatches: mism,
    reactions_computed: reactionsComputed,
    reactions_pending: reactionsPending,
    reactions_unavailable: reactionsUnavailable,
    companies_total: companyIds.size,
    entities_unassigned: entitiesUnassigned,
    companies_with_inconsistent_financials: crossListing.same_currency_count,
    companies_with_inconsistent_financials_samples: crossListing.same_currency_samples,
    companies_with_fx_mismatch: crossListing.fx_mismatch_count,
    companies_with_fx_mismatch_samples: crossListing.fx_mismatch_samples,
    reported_without_document: reportedWithoutDocument,
    reported_without_document_samples: reportedWithoutDocumentSamples,
    reported_without_document_structural: reportedWithoutDocumentStructural,
    sp500_complete_pct: sp500CompletePct,
    freshness,
    estimator_label_conflicts: estimatorLabelConflicts,
    marketcap_stale_count: marketcapStale,
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
  if (current.companies_with_inconsistent_financials > 0) {
    reasons.push(
      `companies_with_inconsistent_financials=${current.companies_with_inconsistent_financials} — same-company listings show different revenue in the SAME currency for the same period`,
    );
  }
  // companies_with_fx_mismatch (v3) is INFORMATIONAL — cross-listing
  // currency differences are structural (Deutsche Telekom BRL/EUR,
  // Telenor NOK/USD). Visible in the report, not degradation-triggering.
  // Freshness · stale > 10 is the decay canary. Same-day intraday lag
  // (a handful of legit late-day reporters) shouldn't flip status;
  // systemic ingest failure across the universe will show >10.
  if (current.freshness && current.freshness.stale > 10) {
    reasons.push(
      `freshness.stale=${current.freshness.stale} — >10 tickers have an expected report >7 days past with no matching event`,
    );
  }
  // Phase 4 · report-attachment rule. NO GRACE — the rule is absolute:
  // reported && !document is invalid. Even a single leak flips status.
  if (current.reported_without_document > 0) {
    reasons.push(
      `reported_without_document=${current.reported_without_document} — past events with actuals but no filing sourceLink violate the report-attachment rule`,
    );
  }
  // Phase 4 · SP500 completeness canary. 98% floor; below that a pipe
  // has broken (SP500 has no coverage excuses — CIK, analysts, US bars,
  // EDGAR all guaranteed).
  // sp500_complete_pct floor. Only fires when the SP500 universe
  // exists in the registry (sp500_complete_pct === 0 with no members
  // means the ingest reference hasn't been applied yet — no signal).
  // With members present, the rule catches decay of the 98% floor.
  if (
    typeof current.sp500_complete_pct === "number" &&
    current.sp500_complete_pct < 98
  ) {
    reasons.push(
      `sp500_complete_pct=${current.sp500_complete_pct}% — SP500 latest-quarter completeness below the 98% floor`,
    );
  }
  if (current.estimator_label_conflicts > 0) {
    reasons.push(
      `estimator_label_conflicts=${current.estimator_label_conflicts} — forward shells labelled at/before latest reported period (non-calendar-year fiscal label drift)`,
    );
  }
  // Part 5c: marketcap_stale_count degraded threshold — 10% of canonicals.
  if (
    current.companies_total > 0 &&
    current.marketcap_stale_count > current.companies_total * 0.1
  ) {
    const pct = Math.round(
      (current.marketcap_stale_count / current.companies_total) * 100,
    );
    reasons.push(
      `marketcap_stale_count=${current.marketcap_stale_count} (${pct}% of canonicals stale >7d) — sector + search orderings silently corrupt`,
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
