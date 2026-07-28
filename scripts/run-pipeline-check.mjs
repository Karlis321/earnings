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

function countDuplicates(events) {
  const byTicker = new Map();
  for (const ev of events) {
    if (!ev.eventDate) continue;
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker).push(ev);
  }
  let d = 0;
  for (const [, past] of byTicker) {
    const byPeriod = new Map();
    for (const ev of past) byPeriod.set(ev.period ?? "", (byPeriod.get(ev.period ?? "") ?? 0) + 1);
    for (const [, n] of byPeriod) if (n > 1) d += n - 1;
    const sorted = past.slice().sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (a.period === b.period) continue;
      if (daysBetween(a.eventDate, b.eventDate) > CLOSE_DAYS) continue;
      const yA = (a.period ?? "").match(/FY(\d{4})/)?.[1];
      const yB = (b.period ?? "").match(/FY(\d{4})/)?.[1];
      if (yA && yB && yA !== yB) continue;
      d++;
    }
  }
  return d;
}

function countCorpusQualityGaps(events) {
  let missingProv = 0, missingCurrency = 0;
  for (const ev of events) {
    if (!ev.provenance) missingProv++;
    for (const m of ev.metrics ?? []) {
      if (m.actual?.value == null) continue;
      const isCurrencyMetric = /^(revenue_|eps_|ebitda_|adj_ebitda_|net_income_|gross_profit_|operating_income_|dr_eps_)/.test(m.key);
      const isValidCurrencyUnit =
        /^[A-Z]{3}(_m)?$/.test(m.actual.unit ?? "") ||
        /^[A-Z]{3}\/shares$/.test(m.actual.unit ?? "");
      if (isCurrencyMetric && !isValidCurrencyUnit) missingCurrency++;
    }
  }
  return { events_missing_provenance: missingProv, metrics_missing_currency: missingCurrency };
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
  const dupes = countDuplicates(snap.events);
  const mism = countIndexMismatches(index, snap.events);
  // Reaction counters (schema v2). `unavailable` is a terminal state
  // stamped by matureEventReaction / scripts/apply-reaction-decay.mjs
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
  // fiscal period. Alphabet violated this (4 listings × 4 different
  // Q2 2026 values) in the July-2026 audit.
  const registry = await readJson(REGISTRY, { entities: [] });
  const companyByTicker = new Map();
  for (const e of registry.entities ?? []) {
    if (e.companyId) companyByTicker.set(e.ticker, e.companyId);
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
    if (!perCo.has(key)) perCo.set(key, { values: [], tickers: new Set() });
    const cell = perCo.get(key);
    cell.values.push(rev.value);
    cell.tickers.add(ev.ticker);
  }
  const inconsistent = new Set();
  for (const [cid, perCo] of groups) {
    for (const [, cell] of perCo) {
      if (cell.values.length < 2) continue;
      const min = Math.min(...cell.values);
      const max = Math.max(...cell.values);
      const denom = Math.max(Math.abs(max), 1e-9);
      if (((max - min) / denom) * 100 > 0.5) inconsistent.add(cid);
    }
  }
  const crossListingBad = inconsistent.size;

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
  const report = {
    schema: "pipeline-report/v2",
    date: now.toISOString().slice(0, 10),
    finishedAt: now.toISOString(),
    status: "ok",
    reasons: [],
    events_total: snap.events.length,
    events_added_today: 0,
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
    companies_with_inconsistent_financials: crossListingBad,
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
  if (report.shard_index_mismatches > 0) reasons.push(`shard_index_mismatches=${report.shard_index_mismatches}`);
  if (report.companies_with_inconsistent_financials > 0)
    reasons.push(
      `companies_with_inconsistent_financials=${report.companies_with_inconsistent_financials} — same-company listings show different revenue for the same period`,
    );
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
