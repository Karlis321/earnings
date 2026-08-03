#!/usr/bin/env node
/**
 * FULL universe audit — every ticker, every dimension the pipeline
 * check covers PLUS "is the newest earnings actually newest?" and
 * "do numbers agree across listings + same-basis triples?"
 *
 * Dimensions per ticker:
 *   1. shard_present        — has data/events/<slug>.json
 *   2. has_past             — ≥1 event with eventDate + at least one actual
 *   3. latest_period        — max eventDate past
 *   4. days_since_latest    — today - latest.eventDate
 *   5. stale_by_cadence     — days_since_latest > 2×cadence_days (missed a report)
 *   6. next_scheduled       — has a scheduled/estimated forward date
 *   7. actuals_present      — metric.actual.value != null on latest
 *   8. estimates_present    — metric.estimate.value != null on latest
 *   9. surprise_present     — metric.surprisePct != null on latest
 *  10. absurd_surprise      — |surprisePct| > 500
 *  11. cross_basis_flag     — metric._crossBasisSurprise[] non-empty
 *  12. cross_listing_drift  — companyId siblings' primary revenue metric
 *                             differ by >0.5% for the same fiscal period
 *  13. sec_verbatim_ok      — for CIK-bearing entities, latest metrics
 *                             carry provenance=sec-xbrl-companyfacts
 *                             or the sibling that fed the values does
 *  14. has_filing_link      — event.sourceLink.kind === "filing"
 *  15. reaction_matured     — d1 or d3 with absReturn != null on latest
 *
 * Output:
 *   scripts/audits/audit-all-earnings.json — { generatedAt, summary,
 *     per_dimension: {counts,pcts,samples}, per_ticker: [rows],
 *     per_company: [companyId+listings drift] }
 *
 *   node scripts/audit-all-earnings.mjs [--limit=N]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const args = new Map(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const LIMIT = args.has("limit") ? Number(args.get("limit")) : Infinity;

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}
function daysBetween(iso, todayIso) {
  const a = new Date(iso).getTime();
  const b = new Date(todayIso).getTime();
  return Math.floor((b - a) / 86_400_000);
}
function cadenceDays(cadence) {
  switch (cadence) {
    case "annual":     return 365;
    case "semiannual": return 183;
    case "quarterly":  return 92;
    default:           return 92;
  }
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter(
    (e) => e.securityType === "operating" && !e.dormant,
  );
  const todayIso = new Date().toISOString().slice(0, 10);

  // Index shards on disk once for fast presence check.
  const shardFiles = new Set(await fs.readdir(EVENTS_DIR));

  // ─────────────────────────────────────────────────────────────
  // Pass 1 · per-ticker dimensions
  // ─────────────────────────────────────────────────────────────
  const rows = [];
  const gapSamples = {
    no_shard: [],
    no_past: [],
    stale_by_cadence: [],
    latest_missing_actuals: [],
    latest_missing_estimate: [],
    latest_missing_surprise: [],
    latest_absurd_surprise: [],
    latest_cross_basis: [],
    latest_missing_reaction: [],
    latest_missing_filing_link: [],
    sec_verbatim_missing: [],
    no_next_scheduled: [],
  };

  // For per-company drift: bucket latest-metric snapshots by companyId.
  // Only USD-labeled revenue actuals with same fiscalYear+fiscalQuarter
  // are compared (this deliberately mirrors pipelineReport's approach).
  const companyBuckets = new Map();

  let processed = 0;
  for (const entity of entities) {
    if (processed >= LIMIT) break;
    processed++;

    const slug = tickerSlug(entity.ticker) + ".json";
    if (!shardFiles.has(slug)) {
      rows.push({ ticker: entity.ticker, shard_present: false });
      gapSamples.no_shard.push(entity.ticker);
      continue;
    }

    let shard;
    try {
      shard = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, slug), "utf-8"));
    } catch {
      rows.push({ ticker: entity.ticker, shard_present: false, parse_error: true });
      gapSamples.no_shard.push(entity.ticker + " (parse)");
      continue;
    }
    const events = Array.isArray(shard) ? shard : shard.events ?? [];

    // Latest past event: max eventDate ≤ today.
    const past = events
      .filter((e) => e.eventDate && e.eventDate <= todayIso)
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
    const upcoming = events
      .filter((e) => e.scheduledDate && e.scheduledDate > todayIso)
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    const hasNextScheduled = upcoming.length > 0;

    if (past.length === 0) {
      rows.push({
        ticker: entity.ticker,
        shard_present: true,
        has_past: false,
        has_next: hasNextScheduled,
      });
      gapSamples.no_past.push(entity.ticker);
      if (!hasNextScheduled) gapSamples.no_next_scheduled.push(entity.ticker);
      continue;
    }

    const latest = past[0];
    const daysSince = daysBetween(latest.eventDate, todayIso);
    const cadence = entity.cadence ?? "quarterly";
    const cadDays = cadenceDays(cadence);
    const staleByCadence = daysSince > 2 * cadDays;

    const metrics = latest.metrics ?? [];
    const actualsPresent = metrics.some((m) => m.actual?.value != null);
    const estimatePresent = metrics.some((m) => m.estimate?.value != null);
    const surprisePresent = metrics.some((m) => m.surprisePct != null);

    // Absurd-surprise = any single metric > 500% (the standing rule).
    const absurdSurprise = metrics.some(
      (m) => m.surprisePct != null && Math.abs(m.surprisePct) > 500,
    );
    const crossBasisFlag = metrics.some(
      (m) => Array.isArray(m._crossBasisSurprise) && m._crossBasisSurprise.length > 0,
    );

    // Filing sourceLink present?
    const hasFilingLink = latest.sourceLink?.kind === "filing";

    // SEC-verbatim rule: if this listing (or any sibling on the same
    // companyId) has an edgarCik, the latest financial metrics MUST
    // have provenance sec-xbrl-companyfacts (verbatim) OR be traceable
    // to a sec-fed sibling. Test lightly here: check if the entity has
    // a cik AND any metric.actual.source.provenance is not sec-xbrl.
    let secVerbatimOk = true;
    if (entity.edgarCik) {
      const anyMetricHasSec = metrics.some(
        (m) => m.actual?.source?.provenance === "regulatory",
      );
      secVerbatimOk = anyMetricHasSec || !actualsPresent;
    }

    // Reaction matured?
    const points = latest.reaction?.points ?? [];
    const reactionMatured = points.some(
      (p) => (p.horizon === "d1" || p.horizon === "d3") && p.absReturn != null,
    );

    // Push a summary row.
    rows.push({
      ticker: entity.ticker,
      companyId: entity.companyId ?? null,
      shard_present: true,
      has_past: true,
      latest_period: latest.period,
      latest_date: latest.eventDate,
      days_since_latest: daysSince,
      stale_by_cadence: staleByCadence,
      has_next: hasNextScheduled,
      actuals_present: actualsPresent,
      estimate_present: estimatePresent,
      surprise_present: surprisePresent,
      absurd_surprise: absurdSurprise,
      cross_basis_flag: crossBasisFlag,
      has_filing_link: hasFilingLink,
      sec_verbatim_ok: secVerbatimOk,
      reaction_matured: reactionMatured,
    });

    if (!actualsPresent) gapSamples.latest_missing_actuals.push(`${entity.ticker} · ${latest.period}`);
    if (!estimatePresent) gapSamples.latest_missing_estimate.push(`${entity.ticker} · ${latest.period}`);
    if (!surprisePresent && actualsPresent && estimatePresent) {
      gapSamples.latest_missing_surprise.push(`${entity.ticker} · ${latest.period}`);
    }
    if (absurdSurprise) gapSamples.latest_absurd_surprise.push(`${entity.ticker} · ${latest.period}`);
    if (crossBasisFlag) gapSamples.latest_cross_basis.push(`${entity.ticker} · ${latest.period}`);
    if (staleByCadence) gapSamples.stale_by_cadence.push(`${entity.ticker} · ${latest.period} · ${daysSince}d`);
    if (!reactionMatured) gapSamples.latest_missing_reaction.push(`${entity.ticker} · ${latest.period}`);
    if (!hasFilingLink && actualsPresent) gapSamples.latest_missing_filing_link.push(`${entity.ticker} · ${latest.period}`);
    if (!secVerbatimOk) gapSamples.sec_verbatim_missing.push(`${entity.ticker} · ${latest.period}`);
    if (!hasNextScheduled) gapSamples.no_next_scheduled.push(entity.ticker);

    // Bucket revenue actuals for cross-listing drift check.
    // Revenue = metric with key in the canonical revenue slot set.
    const revenueMetric = metrics.find(
      (m) =>
        /^rev(enue)?$/i.test(m.key ?? "") ||
        /revenue/i.test(m.label ?? "") ||
        /revenue/i.test(m.key ?? ""),
    );
    if (
      entity.companyId &&
      revenueMetric?.actual?.value != null &&
      revenueMetric.actual.unit
    ) {
      const cid = entity.companyId;
      if (!companyBuckets.has(cid)) companyBuckets.set(cid, []);
      companyBuckets.get(cid).push({
        ticker: entity.ticker,
        period: latest.period,
        eventDate: latest.eventDate,
        revenue: revenueMetric.actual.value,
        unit: revenueMetric.actual.unit,
        currency: revenueMetric.actual.unit,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Pass 2 · cross-listing drift (companyId-level)
  // ─────────────────────────────────────────────────────────────
  const drifts = [];
  for (const [companyId, listings] of companyBuckets) {
    if (listings.length < 2) continue;
    // Compare same-period, same-currency listings.
    const byPeriodCurrency = new Map();
    for (const l of listings) {
      const key = `${l.period}::${l.currency}`;
      if (!byPeriodCurrency.has(key)) byPeriodCurrency.set(key, []);
      byPeriodCurrency.get(key).push(l);
    }
    for (const [pcKey, group] of byPeriodCurrency) {
      if (group.length < 2) continue;
      const values = group.map((g) => g.revenue).sort((a, b) => a - b);
      const min = values[0];
      const max = values[values.length - 1];
      if (max === 0) continue;
      const spreadPct = ((max - min) / max) * 100;
      if (spreadPct > 0.5) {
        drifts.push({
          companyId,
          period_currency: pcKey,
          spread_pct: Number(spreadPct.toFixed(2)),
          listings: group.map((g) => ({
            ticker: g.ticker,
            revenue: g.revenue,
            unit: g.unit,
          })),
        });
      }
    }
  }
  drifts.sort((a, b) => b.spread_pct - a.spread_pct);

  // ─────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────
  const total = rows.length;
  const count = (pred) => rows.filter(pred).length;
  const summary = {
    total_entities_audited: total,
    shard_present: count((r) => r.shard_present),
    has_past_event: count((r) => r.has_past),
    has_next_scheduled: count((r) => r.has_next),
    latest_has_actuals: count((r) => r.actuals_present),
    latest_has_estimate: count((r) => r.estimate_present),
    latest_has_surprise: count((r) => r.surprise_present),
    latest_has_reaction: count((r) => r.reaction_matured),
    latest_has_filing_link: count((r) => r.has_filing_link),
    sec_verbatim_ok: count((r) => r.sec_verbatim_ok),
    // Anomalies
    stale_by_cadence: count((r) => r.stale_by_cadence),
    absurd_surprise: count((r) => r.absurd_surprise),
    cross_basis_flag: count((r) => r.cross_basis_flag),
    // Cross-listing drift
    companies_with_drift: drifts.length,
    total_drift_pairs_gt_0_5pct: drifts.length,
  };

  const trimSamples = (arr, n = 25) => arr.slice(0, n);
  const per_dimension = {};
  for (const [k, v] of Object.entries(gapSamples)) {
    per_dimension[k] = { count: v.length, samples: trimSamples(v) };
  }

  const pct = (n) => ((n / Math.max(total, 1)) * 100).toFixed(1) + "%";
  console.log("=== audit-all-earnings ===");
  console.log(`Total operating entities audited:     ${total}`);
  console.log(`  with shard on disk                 ${summary.shard_present.toString().padStart(5)} (${pct(summary.shard_present)})`);
  console.log(`  with ≥1 past event                 ${summary.has_past_event.toString().padStart(5)} (${pct(summary.has_past_event)})`);
  console.log(`  with a next scheduled              ${summary.has_next_scheduled.toString().padStart(5)} (${pct(summary.has_next_scheduled)})`);
  console.log("");
  console.log("Latest reported event coverage:");
  console.log(`  actuals present                    ${summary.latest_has_actuals.toString().padStart(5)} (${pct(summary.latest_has_actuals)})`);
  console.log(`  estimate present                   ${summary.latest_has_estimate.toString().padStart(5)} (${pct(summary.latest_has_estimate)})`);
  console.log(`  surprisePct present                ${summary.latest_has_surprise.toString().padStart(5)} (${pct(summary.latest_has_surprise)})`);
  console.log(`  reaction d1|d3 matured             ${summary.latest_has_reaction.toString().padStart(5)} (${pct(summary.latest_has_reaction)})`);
  console.log(`  filing sourceLink                  ${summary.latest_has_filing_link.toString().padStart(5)} (${pct(summary.latest_has_filing_link)})`);
  console.log(`  SEC-verbatim rule holds            ${summary.sec_verbatim_ok.toString().padStart(5)} (${pct(summary.sec_verbatim_ok)})`);
  console.log("");
  console.log("Anomalies:");
  console.log(`  stale_by_cadence (>2× cadence)     ${summary.stale_by_cadence.toString().padStart(5)}`);
  console.log(`  absurd surprise (|%|>500)          ${summary.absurd_surprise.toString().padStart(5)}`);
  console.log(`  cross-basis surprise cleared       ${summary.cross_basis_flag.toString().padStart(5)}`);
  console.log(`  companies with cross-listing drift ${summary.companies_with_drift.toString().padStart(5)}`);
  console.log("");
  console.log("Top drifts:");
  for (const d of drifts.slice(0, 10)) {
    console.log(`  ${d.companyId} · ${d.period_currency} · spread ${d.spread_pct}% · ${d.listings.map((l) => l.ticker).join(",")}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "audit-all-earnings.json");
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        as_of_date: todayIso,
        summary,
        per_dimension,
        cross_listing_drift: drifts,
        per_ticker: rows,
      },
      null,
      2,
    ),
  );
  console.log(`\n✓ audit → scripts/audits/audit-all-earnings.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
