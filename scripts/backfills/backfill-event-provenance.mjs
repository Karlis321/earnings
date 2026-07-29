#!/usr/bin/env node
/**
 * DEPRECATED (shard-first): reads + writes data/earnings.json (gitignored).
 * Shards are canonical now. This retroactive stamp already ran; kept for
 * archival re-runs against a locally-reconstituted monolith.
 *
 * Stamp EventRecord.provenance retroactively on existing events based
 * on their metric source labels. Idempotent — safe to re-run.
 *
 * Heuristic (first match wins):
 *   - Any metric.source.label starts "SEC EDGAR" → sec-xbrl-companyfacts
 *     (unless the metric key is filing_reference → sec-submissions)
 *   - Any metric.source.label = "Yahoo · fundamentals-timeseries"
 *       → yahoo-timeseries
 *   - Any metric.source.label starts "FMP" → fmp
 *   - freshness = "stale" + no eventDate → estimator-median-gap
 *   - otherwise → yahoo-earnings-chart
 *
 *   node scripts/backfill-event-provenance.mjs
 *   node scripts/backfill-event-provenance.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;

function classify(event) {
  // Estimator shells: no eventDate + no populated metrics, freshness stale.
  const hasActual = (event.metrics ?? []).some(
    (m) => (m.actual?.value ?? null) !== null,
  );
  if (!event.eventDate && !hasActual && event.freshness === "stale") {
    return "estimator-median-gap";
  }
  // Walk metric sources; first strong hit wins.
  for (const m of event.metrics ?? []) {
    const label = m.actual?.source?.label ?? "";
    if (label.startsWith("SEC EDGAR")) {
      // filing_reference indicates a sec-submissions shell, not XBRL
      if (m.key === "filing_reference") return "sec-submissions";
      return "sec-xbrl-companyfacts";
    }
    if (label === "Yahoo · fundamentals-timeseries") return "yahoo-timeseries";
    if (label.startsWith("FMP")) return "fmp";
  }
  // Yahoo Finance labels (earnings / financials / analysis) — original path
  for (const m of event.metrics ?? []) {
    const label = m.actual?.source?.label ?? "";
    if (label.startsWith("Yahoo Finance")) return "yahoo-earnings-chart";
  }
  // Empty metrics with future date → shell built by buildEventShell (Yahoo path)
  if (!event.eventDate && !hasActual) return "yahoo-earnings-chart";
  return "yahoo-earnings-chart";
}

async function main() {
  console.log(`backfill-event-provenance · dry=${DRY}`);
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));

  const buckets = {};
  let stamped = 0;
  const now = new Date().toISOString();
  for (const ev of snap.events) {
    if (ev.provenance) {
      buckets[ev.provenance] = (buckets[ev.provenance] ?? 0) + 1;
      continue;
    }
    const p = classify(ev);
    ev.provenance = p;
    ev.provenanceAsOf = now;
    buckets[p] = (buckets[p] ?? 0) + 1;
    stamped++;
  }

  console.log(`\nStamped ${stamped} events`);
  console.log(`Distribution:`);
  for (const [p, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(28)} ${n}`);
  }

  if (DRY) { console.log("Dry run — no write."); return; }
  await fs.writeFile(EARNINGS, JSON.stringify(snap, null, 2));
  console.log(`✓ wrote ${EARNINGS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
