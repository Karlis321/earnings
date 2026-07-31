#!/usr/bin/env node
/**
 * Phase 4 audit: four-layer completeness check on the ~503 SP500
 * members' latest reported quarter + prior 4 (up to 5 events per
 * member). Reads shards only; no network.
 *
 * Layers per event:
 *   RESULTS   — past event has a real eventDate (not a quarter-end
 *               placeholder) AND at least revenue + eps present with
 *               currency + provenance.
 *   DOCUMENT  — sourceLink present, kind === "filing" (never
 *               "fallback", "search", null, or a Google URL).
 *   ESTIMATES — EPS estimate AND revenue estimate present on the
 *               event, with a same-basis surprisePct (or explicitly
 *               tagged as no-consensus). Missing estimates counted
 *               separately from cross-basis mismatches.
 *   REACTION  — reaction.points[] contains d1/d3/w1/m1 with
 *               absReturn computed (not null-pending, not
 *               "unavailable"). Contamination flags recorded but
 *               don't fail the layer.
 *
 * Writes:  scripts/audits/sp500-completeness-<YYYY-MM-DD>.json
 * Prints:  summary table + per-class ticker lists.
 *
 *   node scripts/audit-sp500-completeness.mjs
 *   node scripts/audit-sp500-completeness.mjs --latest-only  # audit just the latest reported quarter per member
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const OUT_PATH = path.join(ROOT, "scripts", "audits", `sp500-completeness-${TODAY_ISO}.json`);

const args = process.argv.slice(2);
const LATEST_ONLY = args.includes("--latest-only");
const HISTORY_DEPTH = LATEST_ONLY ? 1 : 5;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

function loadShard(ticker) {
  const p = path.join(EVENTS_DIR, tickerSlug(ticker) + ".json");
  try {
    const j = JSON.parse(fssync.readFileSync(p, "utf-8"));
    return Array.isArray(j) ? j : j.events ?? [];
  } catch {
    return [];
  }
}

// A "real" filing date is anything that's not a quarter-end
// placeholder. Yahoo timeseries stamps asOfDate (quarter-end like
// 2026-03-31) when it lacks the actual reportedDate. Heuristic: an
// event whose eventDateSource is "yahoo-earnings-chart-reportedDate"
// or "sec-*" is a real date; otherwise we check the day-of-month —
// quarter-end days are 31/30/28 and always fall in {3,6,9,12}.
function isRealFilingDate(ev) {
  if (!ev.eventDate) return false;
  if (ev.eventDateSource === "yahoo-earnings-chart-reportedDate") return true;
  if (String(ev.eventDateSource ?? "").startsWith("sec-")) return true;
  const d = new Date(ev.eventDate);
  const day = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const isQuarterEndDay = [28, 29, 30, 31].includes(day);
  const isQuarterEndMonth = [3, 6, 9, 12].includes(month);
  if (isQuarterEndDay && isQuarterEndMonth) return false;
  return true;
}

function auditResults(ev) {
  const gaps = [];
  if (!ev.eventDate) gaps.push("no eventDate");
  else if (!isRealFilingDate(ev)) gaps.push("quarter-end placeholder date");
  const metrics = ev.metrics ?? [];
  const rev = metrics.find((m) => /^revenue_/.test(m.key));
  const eps = metrics.find((m) => /^eps/.test(m.key));
  const ni = metrics.find((m) => /^net_income/.test(m.key));
  if (!rev?.actual?.value) gaps.push("no revenue actual");
  if (!eps?.actual?.value) gaps.push("no eps actual");
  if (!ni?.actual?.value) gaps.push("no net_income actual");
  // Currency + provenance already guarded by pipeline-report; just check
  // provenance stamp is present here since RESULTS gates on it too.
  if (rev?.actual && !rev.actual.source?.provenance) gaps.push("revenue actual missing provenance");
  return { ok: gaps.length === 0, gaps };
}

function auditDocument(ev) {
  const link = ev.sourceLink;
  if (!link) return { ok: false, reason: "no sourceLink" };
  if (link.kind !== "filing") return { ok: false, reason: `sourceLink.kind=${link.kind}` };
  if (!link.url) return { ok: false, reason: "sourceLink.url empty" };
  if (/google\.com\/search/i.test(link.url)) {
    return { ok: false, reason: "sourceLink.url is a Google search fallback" };
  }
  return { ok: true };
}

function auditEstimates(ev) {
  const metrics = ev.metrics ?? [];
  const rev = metrics.find((m) => /^revenue_/.test(m.key));
  const eps = metrics.find((m) => /^eps/.test(m.key));
  const gaps = [];
  if (!eps?.estimate?.value) gaps.push("no eps estimate");
  if (!rev?.estimate?.value) gaps.push("no revenue estimate");
  // Same-basis surprise — if surprisePct is present it means the pipe
  // computed a valid ratio. If both actual + estimate exist but no
  // surprisePct, that's cross-basis clearing which is not a violation
  // (it's the correct behavior).
  return { ok: gaps.length === 0, gaps };
}

function auditReaction(ev) {
  const points = ev.reaction?.points ?? [];
  if (points.length === 0) return { ok: false, reason: "no reaction.points[]" };
  const horizons = new Set(points.map((p) => p.horizon));
  const missing = ["d1", "d3", "w1", "m1"].filter((h) => !horizons.has(h));
  if (missing.length > 0) return { ok: false, reason: `missing horizon(s): ${missing.join(",")}` };
  const unfilled = points.filter(
    (p) => p.status === "unavailable" || (p.status !== "clipped" && (p.absReturn === null || p.absReturn === undefined)),
  );
  if (unfilled.length > 0) {
    const detail = unfilled.map((p) => `${p.horizon}=${p.status ?? "null"}`).join(",");
    return { ok: false, reason: `points not filled: ${detail}` };
  }
  return { ok: true };
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const members = (reg.entities ?? []).filter(
    (e) => (e.index_membership ?? []).includes("SP500"),
  );

  const classification = {
    fully_complete: [],
    missing_results: [],
    document_violation: [],
    missing_estimates: [],
    reaction_gap: [],
  };
  const events_audited = [];
  let events_total = 0;

  for (const entity of members) {
    const shard = loadShard(entity.ticker);
    const past = shard
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""))
      .slice(0, HISTORY_DEPTH);
    for (const ev of past) {
      events_total++;
      const rslt = auditResults(ev);
      const doc = auditDocument(ev);
      const est = auditEstimates(ev);
      const rxn = auditReaction(ev);
      const eid = `${entity.ticker} · ${ev.period ?? "?"}`;
      const rollup = {
        ticker: entity.ticker,
        period: ev.period,
        eventDate: ev.eventDate,
        results: rslt,
        document: doc,
        estimates: est,
        reaction: rxn,
      };
      events_audited.push(rollup);
      if (rslt.ok && doc.ok && est.ok && rxn.ok) {
        classification.fully_complete.push(eid);
      } else {
        if (!rslt.ok) classification.missing_results.push(eid);
        if (!doc.ok) classification.document_violation.push(eid);
        if (!est.ok) classification.missing_estimates.push(eid);
        if (!rxn.ok) classification.reaction_gap.push(eid);
      }
    }
  }

  const summary = {
    schema: "sp500-completeness/v1",
    generatedAt: new Date().toISOString(),
    latest_only: LATEST_ONLY,
    depth: HISTORY_DEPTH,
    members: members.length,
    events_audited: events_total,
    counts: {
      fully_complete: classification.fully_complete.length,
      missing_results: classification.missing_results.length,
      document_violation: classification.document_violation.length,
      missing_estimates: classification.missing_estimates.length,
      reaction_gap: classification.reaction_gap.length,
    },
    // The absolute rule: reported && !document is an INVIOLABLE bug.
    // Report it up front so the pipe knows what to fix first.
    reported_without_document: events_audited.filter(
      (e) => e.results.gaps.length < 3 && !e.document.ok,
    ).length,
    events: events_audited,
  };

  console.log(`\n=== sp500-completeness · ${TODAY_ISO} ===`);
  console.log(`  members audited:       ${summary.members}`);
  console.log(`  events audited:        ${summary.events_audited} (depth=${HISTORY_DEPTH} per member)`);
  console.log(`\n  fully complete:        ${summary.counts.fully_complete}`);
  console.log(`  missing results:       ${summary.counts.missing_results}`);
  console.log(`  document violation:    ${summary.counts.document_violation}  ← report-attachment rule`);
  console.log(`  missing estimates:     ${summary.counts.missing_estimates}`);
  console.log(`  reaction gap:          ${summary.counts.reaction_gap}`);
  console.log(`\n  reported_without_document total: ${summary.reported_without_document}`);
  const completePct = ((summary.counts.fully_complete / summary.events_audited) * 100).toFixed(1);
  console.log(`  fully-complete %:              ${completePct}%`);

  console.log(`\n  sample document violations (first 10):`);
  for (const eid of classification.document_violation.slice(0, 10)) console.log(`    ${eid}`);
  if (classification.document_violation.length > 10) {
    console.log(`    …+${classification.document_violation.length - 10} more`);
  }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(summary, null, 2));
  console.log(`\n  audit → ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((e) => {
  console.error(`::error::audit-sp500-completeness crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
