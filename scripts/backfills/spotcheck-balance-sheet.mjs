#!/usr/bin/env node
/**
 * Task 3 acceptance — verify 10 random balance-sheet values against
 * SEC XBRL companyfacts. For each pick: fetch the company's CIK
 * facts, look up the specific XBRL concept + end date the stored
 * fact claims, and compare the raw SEC value to the stored value.
 *
 *   node scripts/spotcheck-balance-sheet.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const BS_KEYS = ["total_cash_usd_m", "long_term_debt_usd_m", "shareholders_equity_usd_m", "weighted_diluted_shares_m"];
const SAMPLE_N = 10;
const SEC_UA = "Earnings Tracker (klpp@bluorbank.lv)";

async function fetchFacts(cik) {
  const padded = String(cik).padStart(10, "0");
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.facts ?? null;
}

async function main() {
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"));
  const cikByTicker = new Map();
  for (const e of reg.entities || []) if (e.edgarCik) cikByTicker.set(e.ticker, e.edgarCik);

  const files = (await fs.readdir(path.join(ROOT, "data", "events"))).filter((f) => f.endsWith(".json"));
  const candidates = [];
  for (const f of files) {
    const j = JSON.parse(await fs.readFile(path.join(ROOT, "data", "events", f), "utf-8"));
    const evs = Array.isArray(j) ? j : j.events || [];
    for (const ev of evs) {
      if (!ev.eventDate) continue;
      const cik = cikByTicker.get(ev.ticker);
      if (!cik) continue;
      for (const key of BS_KEYS) {
        const m = (ev.metrics || []).find((mm) => mm.key === key);
        if (!m?.actual?.value) continue;
        if (m.actual.method !== "filing_manual") continue;
        candidates.push({ ticker: ev.ticker, cik, period: ev.period, eventDate: ev.eventDate, key, metric: m });
      }
    }
  }
  console.log(`candidates: ${candidates.length} — sampling ${SAMPLE_N}`);

  // Shuffle + take N
  candidates.sort(() => Math.random() - 0.5);
  const picks = candidates.slice(0, SAMPLE_N);

  const factsCache = new Map();
  const results = [];
  for (const [i, p] of picks.entries()) {
    let facts = factsCache.get(p.cik);
    if (!facts) {
      facts = await fetchFacts(p.cik);
      factsCache.set(p.cik, facts);
      await new Promise((r) => setTimeout(r, 1200)); // SEC fair-access
    }
    const xkey = p.metric.actual.source?.label?.match(/·\s+([A-Za-z]+)$/)?.[1];
    // Source label format is "SEC EDGAR · 10-Q · <xbrlKey>"; extract xbrlKey.
    const label = p.metric.actual.source?.label ?? "";
    const parts = label.split("·").map((s) => s.trim());
    const xbrlKey = parts[parts.length - 1];
    const taxo = ["us-gaap", "ifrs-full"].find((t) => facts?.[t]?.[xbrlKey]);
    if (!taxo) {
      results.push({ ...p, status: "concept-missing", xbrlKey });
      continue;
    }
    const item = facts[taxo][xbrlKey];
    const units = item.units ?? {};
    const unitKey = p.metric.actual.unit;
    const values = units[unitKey] ?? [];
    // Match on end date within ±7d of the stored asOf.
    const targetEnd = new Date(p.metric.actual.asOf).getTime();
    // weighted_diluted_shares_m is DURATION (weighted avg over the
    // quarter), not INSTANT. All other BS_KEYS are instant.
    const isInstantKey = p.key !== "weighted_diluted_shares_m";
    let best = null;
    let bestDelta = Infinity;
    let bestFiled = "";
    for (const v of values) {
      if (isInstantKey) {
        if (v.start) continue;
      } else {
        if (!v.start || !v.end) continue;
        const span = (new Date(v.end).getTime() - new Date(v.start).getTime()) / 86_400_000;
        if (span < 80 || span > 100) continue;
      }
      const d = Math.abs(new Date(v.end).getTime() - targetEnd) / 86_400_000;
      if (d < bestDelta || (d === bestDelta && (v.filed ?? "") > bestFiled)) {
        best = v; bestDelta = d; bestFiled = v.filed ?? "";
      }
    }
    const tolerance = isInstantKey ? 7 : 31;
    if (!best || bestDelta > tolerance) {
      results.push({ ...p, status: "no-match", bestDelta });
      continue;
    }
    const secVal = best.val;
    const storedVal = p.metric.actual.value * (p.key === "weighted_diluted_shares_m" ? 1e6 : 1e6);
    const delta = ((storedVal - secVal) / Math.max(Math.abs(secVal), 1)) * 100;
    const ok = Math.abs(delta) < 0.5;
    results.push({ ticker: p.ticker, key: p.key, period: p.period, xbrlKey, unit: unitKey, storedVal, secVal, delta: delta.toFixed(3) + "%", status: ok ? "MATCH" : "MISMATCH" });
    console.log(`  [${i + 1}/${SAMPLE_N}] ${p.ticker.padEnd(10)} ${p.key.padEnd(28)} ${p.period.padEnd(10)} stored=${storedVal.toFixed(0).padStart(14)} sec=${secVal.toFixed(0).padStart(14)} Δ=${delta.toFixed(3)}%  ${ok ? "✓" : "✗"}`);
  }

  const mismatches = results.filter((r) => r.status !== "MATCH");
  console.log(`\n=== Spot-check ===`);
  console.log(`matches:    ${results.filter((r) => r.status === "MATCH").length}/${SAMPLE_N}`);
  console.log(`mismatches: ${mismatches.length}`);

  await fs.writeFile(
    path.join(ROOT, "scripts", "audits", "balance-sheet-spotcheck.json"),
    JSON.stringify({ schema: "bs-spotcheck/v1", generatedAt: new Date().toISOString(), sample: results }, null, 2),
  );
  console.log(`✓ audit → scripts/audits/balance-sheet-spotcheck.json`);
  if (mismatches.length > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
