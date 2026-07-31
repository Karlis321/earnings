#!/usr/bin/env node
/**
 * Corruption test for sp500_complete_pct floor (Phase 4).
 *
 * The counter is % of SP500 members whose LATEST past event clears
 * all 4 layers (results + document + estimates + reaction). Baseline
 * is currently ~0% because Phase 2 ingest just landed and the fix
 * pass hasn't populated documents/estimates yet — the rule fires
 * correctly on that state.
 *
 * The corruption plants a SYNTHETIC fully-complete SP500 event on
 * one member's latest quarter to raise the pct, then removes a
 * layer to prove the rule detects the layer removal.
 *
 *   node scripts/corrupt-sp500-completeness-test.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const CHECK = path.join(__dirname, "run-pipeline-check.mjs");

function runCheck(label) {
  const out = execFileSync("node", [CHECK], { encoding: "utf-8" });
  const pctMatch = out.match(/"sp500_complete_pct":\s*([\d.]+)/);
  const pct = pctMatch ? Number(pctMatch[1]) : null;
  const reasons = out.match(/"reasons":\s*\[[\s\S]*?\]/)?.[0]?.slice(0, 900) ?? "";
  console.log(`\n=== ${label} ===`);
  console.log(`  sp500_complete_pct = ${pct}%`);
  console.log(`  reasons: ${reasons}`);
  return { pct, reasons };
}

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  // Find an SP500 member whose latest event is NOT yet fully
  // complete — planting all four layers on it will raise the pct.
  // (Picking a random SP500 US ticker used to work when baseline
  // was ~0%, but with baseline now ~88% most latest events are
  // already complete and the plant is a no-op.)
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const sp500 = (reg.entities ?? []).filter((e) =>
    (e.index_membership ?? []).includes("SP500") && e.ticker.endsWith(" US"),
  );
  if (sp500.length === 0) {
    console.log("no SP500 members registered — rule cannot be tested. SKIPPING.");
    process.exit(0);
  }
  function isComplete(ev) {
    if (!ev) return false;
    const hasReal = ev.eventDate && (ev.metrics ?? []).some((m) => m.actual?.value != null);
    const link = ev.sourceLink;
    const docOk = link && link.kind === "filing" && link.url && !/google\.com\/search/i.test(link.url);
    const eps = (ev.metrics ?? []).find((m) => /^eps/.test(m.key) && m.estimate?.value != null);
    const estOk = !!eps;
    const pts = ev.reaction?.points ?? [];
    const hzs = new Set(pts.map((p) => p.horizon));
    const daysSince = ev.eventDate ? (Date.now() - new Date(ev.eventDate).getTime()) / 86_400_000 : Infinity;
    const HORIZON_MIN = { d1: 2, d3: 5, w1: 8, m1: 30 };
    const rxnOk =
      ["d1", "d3", "w1", "m1"].every((h) => hzs.has(h)) &&
      pts.every((p) => p.absReturn != null || p.status === "clipped" || daysSince < (HORIZON_MIN[p.horizon] ?? 30));
    return hasReal && docOk && estOk && rxnOk;
  }
  let target = null;
  for (const e of sp500) {
    const shardPath = path.join(EVENTS_DIR, tickerSlug(e.ticker) + ".json");
    let j;
    try { j = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { continue; }
    const events = Array.isArray(j) ? j : j.events ?? [];
    const past = events.filter((x) => x.eventDate).sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
    if (past.length === 0) continue;
    if (isComplete(past[0])) continue;
    target = e;
    break;
  }
  if (!target) {
    console.log("all SP500 members already complete — nothing to plant against. SKIPPING.");
    process.exit(0);
  }
  const shardPath = path.join(EVENTS_DIR, tickerSlug(target.ticker) + ".json");
  const original = await fs.readFile(shardPath, "utf-8");
  const j = JSON.parse(original);
  const events = Array.isArray(j) ? j : j.events ?? [];
  const past = events.filter((e) => e.eventDate);
  past.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  if (past.length === 0) {
    console.log(`${target.ticker} has no past events — SKIPPING.`);
    process.exit(0);
  }
  const targetEv = past[0];
  console.log(`Target: ${target.ticker} · ${targetEv.period} @${targetEv.eventDate}`);

  const baseline = runCheck("BASELINE");

  // Plant a synthetic complete event by adding all four layers.
  const originalEvent = JSON.parse(JSON.stringify(targetEv));
  targetEv.sourceLink = {
    kind: "filing",
    url: "https://www.sec.gov/Archives/edgar/data/000/plant/plant.htm",
  };
  // Ensure metrics has revenue + eps with actual AND estimate.
  const metrics = targetEv.metrics ?? [];
  const findMetric = (rx) => metrics.find((m) => rx.test(m.key));
  const rev = findMetric(/^revenue_/) ?? { key: "revenue_usd_m", actual: null, estimate: null };
  const eps = findMetric(/^eps/) ?? { key: "eps_usd", actual: null, estimate: null };
  rev.actual = rev.actual ?? { value: 1000, unit: "USD", source: { provenance: "sec-xbrl-companyfacts" } };
  rev.estimate = rev.estimate ?? { value: 999, unit: "USD", source: { provenance: "yahoo-earnings-trend" } };
  eps.actual = eps.actual ?? { value: 1.5, unit: "USD", source: { provenance: "sec-xbrl-companyfacts" } };
  eps.estimate = eps.estimate ?? { value: 1.4, unit: "USD", source: { provenance: "yahoo-earnings-chart" } };
  if (!findMetric(/^revenue_/)) metrics.push(rev);
  if (!findMetric(/^eps/)) metrics.push(eps);
  targetEv.metrics = metrics;
  // Reaction: fill all 4 horizons.
  targetEv.reaction = {
    ...targetEv.reaction,
    points: ["d1", "d3", "w1", "m1"].map((h) => ({ horizon: h, absReturn: 0.01, status: "computed" })),
  };
  await fs.writeFile(shardPath, JSON.stringify(j, null, 2));

  const planted = runCheck("AFTER PLANT (synthetic complete event)");

  // Now remove one layer — clear sourceLink — and check that pct
  // decreases and rule fires.
  targetEv.sourceLink = { kind: "fallback", url: "https://www.google.com/search?q=x" };
  await fs.writeFile(shardPath, JSON.stringify(j, null, 2));

  const corrupted = runCheck("AFTER CORRUPTION (removed document)");

  await fs.writeFile(shardPath, original);
  const restored = runCheck("AFTER RESTORE");

  console.log(`\n=== RESULT ===`);
  console.log(`  baseline pct:   ${baseline.pct}%`);
  console.log(`  planted pct:    ${planted.pct}%`);
  console.log(`  corrupted pct:  ${corrupted.pct}%`);
  console.log(`  restored pct:   ${restored.pct}%`);
  const plantedRose = planted.pct > baseline.pct;
  const corruptedFell = corrupted.pct < planted.pct;
  const flagged = /sp500_complete_pct/.test(corrupted.reasons);
  const back = restored.pct === baseline.pct;
  console.log(`  plant raised pct?          ${plantedRose}`);
  console.log(`  corruption dropped pct?    ${corruptedFell}`);
  console.log(`  reason cited in reasons[]? ${flagged}`);
  console.log(`  restored to baseline?      ${back}`);
  if (plantedRose && corruptedFell && flagged && back) {
    console.log(`\n✓ SP500 completeness corruption test PASSED.`);
    process.exit(0);
  } else {
    console.log(`\n✗ SP500 completeness corruption test FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
