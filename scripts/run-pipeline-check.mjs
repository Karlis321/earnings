#!/usr/bin/env node
/**
 * Local self-check runner. Mirrors the end-of-cron step in
 * /api/cron/daily/route.ts:
 *   compute report against current shards → check regressions → print JSON.
 *
 * Used for the audit-prompt Part 4 corruption proof:
 *   node scripts/run-pipeline-check.mjs                # baseline / green
 *   node scripts/run-pipeline-check.mjs --corrupt      # strips one event's
 *                                                       provenance, runs the
 *                                                       check, restores.
 *
 * This is a JS mirror of frontend/server/lib/pipelineReport.ts. Kept in
 * sync manually (like scripts/run-estimator.mjs mirrors the estimator).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const INDEX_PATH = path.join(ROOT, "data", "events-index.json");
const REPORT_PATH = path.join(ROOT, "data", "pipeline-report.json");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const HISTORY_PATH = path.join(ROOT, "data", "pipeline-history.json");

const args = new Set(process.argv.slice(2));
const CORRUPT = args.has("--corrupt");

const CLOSE_DAYS = 45;
function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

function countDuplicates(events, dormant = new Set()) {
  const byTicker = new Map();
  for (const ev of events) {
    if (!ev.eventDate) continue;
    if (dormant.has(ev.ticker)) continue;
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker).push(ev);
  }
  let samePeriod = 0;
  let closeDate = 0;
  const closeDateSamples = [];
  for (const [ticker, past] of byTicker) {
    const byPeriod = new Map();
    for (const ev of past) byPeriod.set(ev.period ?? "", (byPeriod.get(ev.period ?? "") ?? 0) + 1);
    for (const [, n] of byPeriod) if (n > 1) samePeriod += n - 1;
    const sorted = past.slice().sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (a.period === b.period) continue;
      if (daysBetween(a.eventDate, b.eventDate) > CLOSE_DAYS) continue;
      const yA = (a.period ?? "").match(/FY(\d{4})/)?.[1];
      const yB = (b.period ?? "").match(/FY(\d{4})/)?.[1];
      if (yA && yB && yA !== yB) continue;
      closeDate++;
      if (closeDateSamples.length < 5) closeDateSamples.push(ticker);
    }
  }
  return { total: samePeriod + closeDate, same_period: samePeriod, close_date: closeDate, close_date_samples: closeDateSamples };
}

function countCorpusQualityGaps(events) {
  let missingProv = 0, missingCurrency = 0;
  let surpriseInconsistent = 0, metricsDupedInEvent = 0;
  for (const ev of events) {
    if (!ev.provenance) missingProv++;
    const keyCounts = new Map();
    for (const m of ev.metrics ?? []) {
      keyCounts.set(m.key, (keyCounts.get(m.key) ?? 0) + 1);
      if (m.actual?.value == null) continue;
      const isCurrencyMetric = /^(revenue_|eps_|ebitda_|adj_ebitda_|net_income_|gross_profit_|operating_income_|dr_eps_)/.test(m.key);
      const isValidCurrencyUnit =
        /^[A-Z]{3}(_m)?$/.test(m.actual.unit ?? "") ||
        /^[A-Z]{3}\/shares$/.test(m.actual.unit ?? "") ||
        /^[A-Z]{2}[a-z]$/.test(m.actual.unit ?? ""); // sub-unit codes (ZAc, GBp, ILA)
      if (isCurrencyMetric && !isValidCurrencyUnit) missingCurrency++;
      // Stage 1B/e: surprise-triple invariant.
      // If a metric stores a surprisePct and both actual + estimate
      // are present, recompute and flag mismatches >1pp. This catches
      // the cross-basis / stale-actual bugs at pipeline-report time.
      const est = m.estimate?.value;
      if (m.surprisePct != null && est != null && Math.abs(est) > 1e-9) {
        const expected = ((m.actual.value - est) / Math.abs(est)) * 100;
        if (Math.abs(m.surprisePct - expected) > 1.0) surpriseInconsistent++;
      }
    }
    // metrics duplicated in one event's array (countDuplicates only
    // catches event-level dupes).
    for (const [, n] of keyCounts) if (n > 1) metricsDupedInEvent += n - 1;
  }
  return {
    events_missing_provenance: missingProv,
    metrics_missing_currency: missingCurrency,
    metrics_surprise_inconsistent: surpriseInconsistent,
    metrics_duplicated_in_event: metricsDupedInEvent,
  };
}

function countIndexMismatches(index, events) {
  const counts = new Map();
  for (const ev of events) counts.set(ev.ticker, (counts.get(ev.ticker) ?? 0) + 1);
  let m = 0;
  for (const e of index.entries ?? []) {
    if ((counts.get(e.ticker) ?? 0) !== e.count) m++;
  }
  return m;
}

function bucketForwardCoverage(events, today = new Date()) {
  const seen = new Set();
  let confirmed = 0, estimated = 0, inWindow = 0;
  const todayIso = today.toISOString().slice(0, 10);
  const end30 = new Date(today);
  end30.setDate(end30.getDate() + 30);
  const endIso = end30.toISOString().slice(0, 10);
  for (const ev of events) {
    if (ev.eventDate) continue;
    if (seen.has(ev.ticker)) continue;
    seen.add(ev.ticker);
    if (ev.freshness === "stale") estimated++;
    else confirmed++;
    if (ev.scheduledDate && ev.scheduledDate >= todayIso && ev.scheduledDate <= endIso) inWindow++;
  }
  return {
    tickers_with_forward_dates: seen.size,
    forward_dates_confirmed: confirmed,
    forward_dates_estimated: estimated,
    forward_dates_within_30d: inWindow,
  };
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return fallback; }
}

// Mirror of scripts/detect-stale-earnings.mjs (STALE_THRESHOLD=7 days).
// Classifies every canonical operating non-dormant entity into one of
// five freshness buckets. Pure local, no network.
const FRESHNESS_STALE_THRESHOLD_DAYS = 7;
function _fresh_medianGap(sortedTs) {
  if (sortedTs.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < sortedTs.length; i++) gaps.push((sortedTs[i] - sortedTs[i - 1]) / 86_400_000);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}
function _fresh_nextQuarterLabel(period) {
  const m = /^FY(\d{4})\s*Q([1-4])$/.exec(period ?? "");
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  return q === 4 ? `FY${y + 1} Q1` : `FY${y} Q${q + 1}`;
}
function _fresh_hasActuals(ev) { return (ev.metrics ?? []).some((m) => m.actual?.value != null); }
export function classifyFreshness(events, entities, now = new Date()) {
  const todayIso = now.toISOString().slice(0, 10);
  const universe = (entities ?? []).filter(
    (e) => e.securityType === "operating" && e.dormant !== true,
  );
  const byTicker = new Map();
  for (const ev of events) {
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker).push(ev);
  }
  const counts = { fresh: 0, stale: 0, shell_only: 0, no_history: 0, unknown: 0 };
  for (const entity of universe) {
    const list = byTicker.get(entity.ticker) ?? [];
    const past = list
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
    const upcoming = list
      .filter((e) => !e.eventDate)
      .sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
    if (past.length === 0) { counts.no_history++; continue; }
    const pastReal = past.filter(_fresh_hasActuals);
    const datesReal = pastReal.map((e) => new Date(e.eventDate).getTime()).sort((a, b) => a - b);
    const datesAny = past.map((e) => new Date(e.eventDate).getTime()).sort((a, b) => a - b);
    const cadence = _fresh_medianGap(datesReal.length >= 2 ? datesReal : datesAny);
    const anchor = pastReal[0]?.eventDate ?? past[0].eventDate;
    if (!cadence || !anchor) { counts.unknown++; continue; }
    const upcomingIso = upcoming[0]?.scheduledDate ?? null;
    const projectedIso = new Date(new Date(anchor).getTime() + cadence * 86_400_000)
      .toISOString().slice(0, 10);
    const expectedIso = upcomingIso ?? projectedIso;
    const daysPast = Math.floor((new Date(todayIso).getTime() - new Date(expectedIso).getTime()) / 86_400_000);
    const expectedPeriod = upcoming[0]?.period ?? _fresh_nextQuarterLabel(past[0].period);
    if (past[0] && !_fresh_hasActuals(past[0])) { counts.shell_only++; continue; }
    if (expectedPeriod && pastReal.some((e) => e.period === expectedPeriod)) { counts.fresh++; continue; }
    if (daysPast < FRESHNESS_STALE_THRESHOLD_DAYS) { counts.fresh++; continue; }
    counts.stale++;
  }
  const total = universe.length;
  return {
    ...counts,
    fresh_pct: total ? Math.round((counts.fresh / total) * 1000) / 10 : 0,
  };
}

async function compute() {
  // The monolithic earnings.json is .gitignored (see CLAUDE.md) — reconstitute
  // from shards when it isn't present locally so this script still works.
  let snap = await readJson(EARNINGS, null);
  if (!snap) {
    const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
    const events = [];
    for (const f of files) {
      const j = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, f), "utf-8"));
      const evs = Array.isArray(j) ? j : (j.events ?? []);
      for (const ev of evs) events.push(ev);
    }
    snap = { events };
  }
  const index = await readJson(INDEX_PATH, { entries: [] });
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const shardFileCount = files.length;
  const tickersWithPast = new Set();
  for (const ev of snap.events) if (ev.eventDate) tickersWithPast.add(ev.ticker);
  const forward = bucketForwardCoverage(snap.events);
  const quality = countCorpusQualityGaps(snap.events);
  // Registry (loaded once here — used by dormant, cross-listing, marketcap).
  const registryEarly = await readJson(REGISTRY, { entities: [] });
  const dormantTickers = new Set(
    (registryEarly.entities ?? [])
      .filter((e) => e.dormant === true)
      .map((e) => e.ticker),
  );
  const dupes = countDuplicates(snap.events, dormantTickers);
  const mism = countIndexMismatches(index, snap.events);
  // Reaction counters (schema v2). `unavailable` is a terminal state
  // stamped by matureEventReaction / scripts/backfills/apply-reaction-decay.mjs
  // for events >60 trading days old whose baseline bars never fetched.
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  let reactionsComputed = 0;
  let reactionsPending = 0;
  let reactionsUnavailable = 0;
  for (const ev of snap.events) {
    for (const p of ev.reaction?.points ?? []) {
      if (p.status === "unavailable") reactionsUnavailable++;
      else if (p.absReturn !== null && p.absReturn !== undefined) reactionsComputed++;
      else if (p.populatesOn && p.populatesOn <= todayIso) reactionsPending++;
    }
  }

  // Cross-listing revenue consistency invariant. Every listing of a
  // single company must show the same headline revenue for the same
  // fiscal period IN THE SAME CURRENCY. Alphabet violated this
  // (4 listings × 4 different Q2 2026 values) in the July-2026 audit.
  //
  // Split into two buckets:
  //   - same_currency: real bugs (SEC-verbatim rule violated for
  //     listings that share a reporting currency). Degrades the report.
  //   - fx_mismatch: structural — a US ADR and a foreign primary will
  //     always show different numbers because they publish in
  //     different currencies (DTE GR EUR vs DTG US BRL). Informational
  //     only; would only produce noise if used as a degraded trigger.
  const registry = registryEarly;
  const companyByTicker = new Map();
  const currencyByTicker = new Map();
  for (const e of registry.entities ?? []) {
    if (e.companyId) companyByTicker.set(e.ticker, e.companyId);
    if (e.currency) currencyByTicker.set(e.ticker, e.currency);
  }
  const groups = new Map();
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    const cid = companyByTicker.get(ev.ticker);
    if (!cid) continue;
    const rev = ev.metrics?.find((m) => /^revenue_/i.test(m.key ?? ""))?.actual;
    if (rev?.value == null) continue;
    const key = ev.period ?? "";
    if (!groups.has(cid)) groups.set(cid, new Map());
    const perCo = groups.get(cid);
    if (!perCo.has(key)) perCo.set(key, { entries: [] });
    perCo.get(key).entries.push({
      ticker: ev.ticker,
      value: rev.value,
      unit: rev.unit ?? currencyByTicker.get(ev.ticker) ?? "",
    });
  }
  const sameCurrencyBad = new Set();
  const fxMismatch = new Set();
  const sameCurrencySamples = [];
  const fxSamples = [];
  for (const [cid, perCo] of groups) {
    for (const [, cell] of perCo) {
      if (cell.entries.length < 2) continue;
      const byCurrency = new Map();
      for (const e of cell.entries) {
        const cur = (e.unit ?? "").replace(/_m$/, "").replace(/\/shares$/, "");
        if (!byCurrency.has(cur)) byCurrency.set(cur, []);
        byCurrency.get(cur).push(e);
      }
      let flaggedSameCurrency = false;
      for (const [, sameCurEntries] of byCurrency) {
        if (sameCurEntries.length < 2) continue;
        const vals = sameCurEntries.map((e) => e.value);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const denom = Math.max(Math.abs(max), 1e-9);
        if (((max - min) / denom) * 100 > 0.5) {
          if (!sameCurrencyBad.has(cid)) {
            sameCurrencyBad.add(cid);
            if (sameCurrencySamples.length < 5)
              sameCurrencySamples.push(cid);
          }
          flaggedSameCurrency = true;
        }
      }
      if (!flaggedSameCurrency && byCurrency.size > 1) {
        if (!fxMismatch.has(cid)) {
          fxMismatch.add(cid);
          if (fxSamples.length < 5) fxSamples.push(cid);
        }
      }
    }
  }
  const crossListingBad = sameCurrencyBad.size;
  const crossListingFxCount = fxMismatch.size;

  // Sweep 1: estimator label conflicts. Forward shells must carry a
  // period STRICTLY after the ticker's latest reported period.
  const latestPeriod = new Map();
  const latestDate = new Map();
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    const prev = latestDate.get(ev.ticker);
    if (!prev || ev.eventDate > prev) {
      latestDate.set(ev.ticker, ev.eventDate);
      if (ev.period) latestPeriod.set(ev.ticker, ev.period);
    }
  }
  const parsePeriodNum = (label) => {
    const m = /FY\s*(\d{4})\s+Q\s*(\d)/i.exec(label ?? "");
    return m ? Number(m[1]) * 4 + Number(m[2]) : null;
  };
  let estimatorLabelConflicts = 0;
  for (const ev of snap.events) {
    if (ev.eventDate) continue;
    const latest = latestPeriod.get(ev.ticker);
    if (!latest) continue;
    const a = parsePeriodNum(ev.period);
    const b = parsePeriodNum(latest);
    if (a != null && b != null && a <= b) estimatorLabelConflicts++;
  }

  // Part 5c: marketcap_stale_count. Canonical entities whose
  // marketCapAsOf is >7 days old.
  const staleThresholdIso = new Date(now.getTime() - 7 * 86_400_000)
    .toISOString().slice(0, 10);
  let marketcapStale = 0;
  let canonicalTotal = 0;
  for (const e of registry.entities ?? []) {
    if (!e.isCanonical) continue;
    canonicalTotal++;
    const asOf = e.marketCapAsOf ?? "";
    if (!asOf || asOf < staleThresholdIso) marketcapStale++;
  }
  // v3 freshness table. Mirror of scripts/detect-stale-earnings.mjs
  // logic, embedded here so the report always emits current freshness.
  // Classes: FRESH (has an event in the last 400 days OR an upcoming
  // shell), STALE (canonical + last event >400 days OR overdue upcoming),
  // SHELL_ONLY (only forward shells, no past events), NO_HISTORY (no
  // events at all), UNKNOWN (non-canonical listings and dormant entities).
  const freshness = classifyFreshness(snap.events, registry.entities ?? [], now);

  const report = {
    schema: "pipeline-report/v3",
    date: now.toISOString().slice(0, 10),
    finishedAt: now.toISOString(),
    status: "ok",
    reasons: [],
    events_total: snap.events.length,
    events_added_today: 0,
    shard_files: shardFileCount,
    tickers_with_past_events: tickersWithPast.size,
    ...forward,
    duplicates_detected: dupes.same_period,
    duplicates_close_date_fiscal_canary: dupes.close_date,
    duplicates_close_date_samples: dupes.close_date_samples,
    events_missing_provenance: quality.events_missing_provenance,
    metrics_missing_currency: quality.metrics_missing_currency,
    metrics_surprise_inconsistent: quality.metrics_surprise_inconsistent,
    metrics_duplicated_in_event: quality.metrics_duplicated_in_event,
    shard_index_mismatches: mism,
    reactions_computed: reactionsComputed,
    reactions_pending: reactionsPending,
    reactions_unavailable: reactionsUnavailable,
    companies_with_inconsistent_financials: crossListingBad,
    companies_with_inconsistent_financials_samples: sameCurrencySamples,
    companies_with_fx_mismatch: crossListingFxCount,
    companies_with_fx_mismatch_samples: fxSamples,
    freshness,
    estimator_label_conflicts: estimatorLabelConflicts,
    marketcap_stale_count: marketcapStale,
    per_vendor: {
      yahoo_qs: { attempted: 0, succeeded: 0, empty: 0, errored: 0 },
      yahoo_ts: { attempted: 0, succeeded: 0, empty: 0, errored: 0 },
      sec: { attempted: 0, succeeded: 0, empty: 0, errored: 0 },
      fmp: { attempted: 0, succeeded: 0, empty: 0, errored: 0 },
    },
    cron_duration_ms: 0,
  };
  const reasons = [];
  if (report.duplicates_detected > 0) reasons.push(`duplicates_detected=${report.duplicates_detected} — dedup rule leaked`);
  if (report.events_missing_provenance > 0) reasons.push(`events_missing_provenance=${report.events_missing_provenance}`);
  if (report.metrics_missing_currency > 0) reasons.push(`metrics_missing_currency=${report.metrics_missing_currency}`);
  if (report.metrics_surprise_inconsistent > 0)
    reasons.push(
      `metrics_surprise_inconsistent=${report.metrics_surprise_inconsistent} — surprisePct doesn't reconcile with actual/estimate on shard`,
    );
  if (report.metrics_duplicated_in_event > 0)
    reasons.push(
      `metrics_duplicated_in_event=${report.metrics_duplicated_in_event} — same metric.key appears >1 time in one event`,
    );
  if (report.shard_index_mismatches > 0) reasons.push(`shard_index_mismatches=${report.shard_index_mismatches}`);
  if (report.companies_with_inconsistent_financials > 0)
    reasons.push(
      `companies_with_inconsistent_financials=${report.companies_with_inconsistent_financials} — same-company listings show different revenue in the SAME currency for the same period`,
    );
  // companies_with_fx_mismatch (v3) is INFORMATIONAL — cross-listing
  // currency differences are structural, not a bug. Visible in the
  // report but never flips status.
  if (report.freshness && report.freshness.stale > 10) {
    reasons.push(
      `freshness.stale=${report.freshness.stale} — >10 tickers have an expected report >7 days past with no matching event`,
    );
  }
  if (report.estimator_label_conflicts > 0)
    reasons.push(
      `estimator_label_conflicts=${report.estimator_label_conflicts} — forward shells labelled at/before latest reported period`,
    );
  if (
    canonicalTotal > 0 &&
    report.marketcap_stale_count > canonicalTotal * 0.1
  ) {
    const pct = Math.round((report.marketcap_stale_count / canonicalTotal) * 100);
    reasons.push(
      `marketcap_stale_count=${report.marketcap_stale_count} (${pct}% of canonicals stale >7d) — sector + search orderings silently corrupt`,
    );
  }

  // Part 6: reactions_pending growing without new events (compare against
  // the previous history entry — the last one strictly earlier than today,
  // since today's entry gets rewritten each run).
  const prevHistory = await readJson(HISTORY_PATH, { entries: [] });
  const prevEntries = (prevHistory.entries ?? []).slice();
  const prev = [...prevEntries]
    .reverse()
    .find((e) => e.date < report.date) ?? null;
  if (
    prev &&
    typeof prev.reactions_pending === "number" &&
    typeof report.reactions_pending === "number" &&
    report.reactions_pending > prev.reactions_pending &&
    report.events_total <= prev.events_total
  ) {
    reasons.push(
      `reactions_pending growing without new events (${prev.reactions_pending}→${report.reactions_pending})`,
    );
  }

  report.status = reasons.length === 0 ? "ok" : "degraded";
  report.reasons = reasons;
  return report;
}

async function main() {
  if (CORRUPT) {
    // Baseline
    const before = await compute();
    console.log("=== BASELINE ===");
    console.log(JSON.stringify(before, null, 2));

    // Pick the first event with a provenance field and strip it, in one shard.
    // Restore after check.
    const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
    let picked = null;
    for (const f of files) {
      const p = path.join(EVENTS_DIR, f);
      const j = JSON.parse(await fs.readFile(p, "utf-8"));
      const evs = Array.isArray(j) ? j : (j.events ?? []);
      const idx = evs.findIndex((e) => e.provenance);
      if (idx >= 0) {
        picked = { path: p, wrapped: !Array.isArray(j), body: j, idx, evs, originalProv: evs[idx].provenance, originalProvAsOf: evs[idx].provenanceAsOf };
        break;
      }
    }
    if (!picked) { console.error("No event with provenance to corrupt."); return; }

    console.log(`\n>>> Corrupting event id=${picked.evs[picked.idx].id} in ${path.basename(picked.path)} (stripping provenance)…`);
    delete picked.evs[picked.idx].provenance;
    delete picked.evs[picked.idx].provenanceAsOf;
    const corruptBody = picked.wrapped
      ? { ...picked.body, events: picked.evs }
      : picked.evs;
    await fs.writeFile(picked.path, JSON.stringify(corruptBody, null, 2));

    // Also patch the monolith IF it exists — shards are canonical, but a
    // legacy monolith would still be read first by compute() when present.
    let mono = null;
    let monoIdx = -1;
    try {
      mono = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));
      monoIdx = mono.events.findIndex((e) => e.id === picked.evs[picked.idx].id);
      if (monoIdx >= 0) {
        delete mono.events[monoIdx].provenance;
        delete mono.events[monoIdx].provenanceAsOf;
        await fs.writeFile(EARNINGS, JSON.stringify(mono, null, 2));
      }
    } catch {
      // earnings.json absent — shards-only run; compute() reconstitutes from them.
    }

    const after = await compute();
    console.log("\n=== AFTER CORRUPTION ===");
    console.log(JSON.stringify(after, null, 2));

    // Restore
    picked.evs[picked.idx].provenance = picked.originalProv;
    if (picked.originalProvAsOf) picked.evs[picked.idx].provenanceAsOf = picked.originalProvAsOf;
    const restoredBody = picked.wrapped
      ? { ...picked.body, events: picked.evs }
      : picked.evs;
    await fs.writeFile(picked.path, JSON.stringify(restoredBody, null, 2));
    if (mono && monoIdx >= 0) {
      mono.events[monoIdx].provenance = picked.originalProv;
      if (picked.originalProvAsOf) mono.events[monoIdx].provenanceAsOf = picked.originalProvAsOf;
      await fs.writeFile(EARNINGS, JSON.stringify(mono, null, 2));
    }
    const restored = await compute();
    console.log("\n=== RESTORED ===");
    console.log(JSON.stringify(restored, null, 2));
    return;
  }

  const report = await compute();
  // Persist locally so the health page shows something.
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  const historyRaw = await readJson(HISTORY_PATH, { schema: "pipeline-history/v1", entries: [] });
  const entry = {
    date: report.date,
    events_total: report.events_total,
    tickers_with_past_events: report.tickers_with_past_events,
    tickers_with_forward_dates: report.tickers_with_forward_dates,
    forward_dates_estimated: report.forward_dates_estimated,
    duplicates_detected: report.duplicates_detected,
    status: report.status,
    reactions_pending: report.reactions_pending,
  };
  const entries = (historyRaw.entries ?? []).slice();
  const eIdx = entries.findIndex((e) => e.date === entry.date);
  if (eIdx >= 0) entries[eIdx] = entry;
  else entries.push(entry);
  await fs.writeFile(HISTORY_PATH, JSON.stringify({ schema: "pipeline-history/v1", entries }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
