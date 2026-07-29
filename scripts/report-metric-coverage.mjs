#!/usr/bin/env node
/**
 * TODO Item 7 — Per-metric before/after population table by provenance.
 *
 * Walks all shards, groups past events by provenance, and reports:
 *   1. missing-revenue-with-siblings (the July-2026 audit's key gap)
 *   2. per-metric population counts across the 14 metric keys added
 *      by Task 2 (Sweep 3 + Part 4)
 *
 * Output is a compact table to stdout + a JSON audit to
 * scripts/audits/metric-coverage.json.
 *
 *   node scripts/report-metric-coverage.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const TRACKED_KEYS = [
  "revenue_usd_m",
  "cost_of_revenue_usd_m",
  "gross_profit_usd_m",
  "operating_income_usd_m",
  "pretax_income_usd_m",
  "net_income_usd_m",
  "eps_usd",
  "eps_diluted_usd",
  "operating_cash_flow_usd_m",
  "capex_usd_m",
  "total_cash_usd_m",
  "total_debt_usd_m",
  "shareholders_equity_usd_m",
  "weighted_diluted_shares_m",
  "gross_margin_pct",
  "operating_margin_pct",
  "net_margin_pct",
  "fcf_usd_m",
];

async function main() {
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  const byProv = new Map();
  let totalPast = 0;
  let missingRevWithSibs = 0;

  for (const f of files) {
    const j = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, f), "utf-8"));
    const evs = Array.isArray(j) ? j : j.events ?? [];
    for (const ev of evs) {
      if (!ev.eventDate) continue;
      totalPast++;
      const prov = ev.provenance ?? "unknown";
      if (!byProv.has(prov)) {
        byProv.set(prov, {
          total: 0,
          missingRev: 0,
          missingRevSibs: 0,
          perMetric: Object.fromEntries(TRACKED_KEYS.map((k) => [k, 0])),
        });
      }
      const s = byProv.get(prov);
      s.total++;
      const rev = (ev.metrics ?? []).find((m) => /^revenue_/i.test(m.key));
      const gp = (ev.metrics ?? []).find((m) => /^gross_profit_/i.test(m.key));
      const oi = (ev.metrics ?? []).find((m) => /^operating_income_/i.test(m.key));
      const ni = (ev.metrics ?? []).find((m) => /^net_income_/i.test(m.key));
      if (!rev?.actual?.value) {
        s.missingRev++;
        if (gp?.actual?.value || oi?.actual?.value || ni?.actual?.value) {
          s.missingRevSibs++;
          missingRevWithSibs++;
        }
      }
      for (const k of TRACKED_KEYS) {
        const m = (ev.metrics ?? []).find((mm) => mm.key === k);
        if (m?.actual?.value != null) s.perMetric[k]++;
      }
    }
  }

  console.log(
    `=== Per-provenance summary (${totalPast} past events across ${files.length} shards) ===`,
  );
  console.log(
    "provenance                    total   missing-rev   missing-rev+sib",
  );
  for (const [p, s] of [...byProv].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      "  " +
        p.padEnd(28) +
        String(s.total).padStart(7) +
        String(s.missingRev).padStart(14) +
        String(s.missingRevSibs).padStart(18),
    );
  }
  console.log(`\nmissing-rev-with-siblings TOTAL: ${missingRevWithSibs}  (baseline was 83; SEC-verbatim + expanded XBRL_MAP should drop it)`);

  // Per-metric coverage rollup — sum across all provenances
  const globalPerMetric = Object.fromEntries(TRACKED_KEYS.map((k) => [k, 0]));
  for (const s of byProv.values()) {
    for (const k of TRACKED_KEYS) globalPerMetric[k] += s.perMetric[k];
  }
  console.log(`\n=== Per-metric coverage (across all past events, all provenances) ===`);
  console.log("metric                         events-populated  pct-of-past");
  for (const k of TRACKED_KEYS) {
    const n = globalPerMetric[k];
    const pct = totalPast > 0 ? ((n / totalPast) * 100).toFixed(1) : "0.0";
    console.log("  " + k.padEnd(30) + String(n).padStart(16) + "  " + pct.padStart(5) + "%");
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const auditPath = path.join(OUT_DIR, "metric-coverage.json");
  await fs.writeFile(
    auditPath,
    JSON.stringify(
      {
        schema: "metric-coverage/v1",
        generatedAt: new Date().toISOString(),
        totalPast,
        totalShards: files.length,
        missingRevWithSibsTotal: missingRevWithSibs,
        missingRevWithSibsBaseline: 83,
        perProvenance: Object.fromEntries(byProv),
        perMetricGlobal: globalPerMetric,
      },
      null,
      2,
    ),
  );
  console.log(`\n✓ audit → ${auditPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
