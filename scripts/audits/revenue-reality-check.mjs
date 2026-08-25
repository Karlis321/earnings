#!/usr/bin/env node
/**
 * Universe-wide revenue reality-check against SEC XBRL.
 *
 * For every CIK-bearing operating ticker: fetch the SEC XBRL Revenues
 * facts (and fallback concepts), match each stored past event's
 * revenue_usd_m against the matching pure-quarter SEC fact (by fy+fp),
 * and flag any mismatch >5%.
 *
 * Diagnosed via NVDA on 2026-08-25: shard stored FY2026 Q1 = $81,615M
 * for revenue_usd_m; SEC reports the pure-quarter value as $44,062M.
 * A Yahoo-provenance leak that never got overwritten by SEC-verbatim.
 * This script surfaces every such gap across the universe.
 *
 * READ-ONLY. Writes only scripts/audits/revenue-reality-check.json.
 * Rate limit: 1 req/s (SEC fair-access policy), one request per CIK
 * (results cached in-run). Typical runtime ~15-25 min for ~1200 US
 * operating CIKs.
 *
 * Concepts checked (fallback chain per CIK):
 *   1. us-gaap:Revenues                                     (legacy)
 *   2. us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax (ASC 606)
 *   3. us-gaap:SalesRevenueNet                              (very legacy)
 *   4. ifrs-full:Revenue                                    (foreign filers)
 *
 * Matching: event.period 'FY2026 Q1' → SEC fact with fy=2026, fp='Q1',
 * span in [80,100] days (pure quarter). Fiscal-offset issuers keep
 * their labels — the fy+fp match handles them.
 *
 *   node scripts/audits/revenue-reality-check.mjs
 *   node scripts/audits/revenue-reality-check.mjs --limit=50
 *   node scripts/audits/revenue-reality-check.mjs --ticker="NVDA US"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_PATH = path.join(__dirname, "revenue-reality-check.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;
const ONLY_TICKER = args.get("ticker") ? String(args.get("ticker")) : null;
const DELTA_FLAG_PCT = 5; // >5% flagged
const REQ_TIMEOUT_MS = 15_000;
const RATE_LIMIT_MS = 500; // 2 req/s — SEC fair-access allows 10 req/s;
                            // we stay well under with a per-CIK companyfacts
                            // fetch that returns every concept in one call.

const UA = "klpp@bluorbank.lv"; // SEC fair-access — real contact per CLAUDE.md
const CONCEPTS = [
  { taxo: "us-gaap", key: "Revenues" },
  { taxo: "us-gaap", key: "RevenueFromContractWithCustomerExcludingAssessedTax" },
  { taxo: "us-gaap", key: "SalesRevenueNet" },
  { taxo: "ifrs-full", key: "Revenue" },
];

function padCik(cik) {
  return String(cik).replace(/^CIK/i, "").padStart(10, "0");
}
function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}
function isPureQuarter(v) {
  if (!v.start || !v.end) return false;
  const span = (new Date(v.end).getTime() - new Date(v.start).getTime()) / 86_400_000;
  return span >= 80 && span <= 100;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) return { status: r.status, body: null };
    return { status: 200, body: await r.json() };
  } catch (e) {
    return { status: 0, body: null, err: e.message };
  } finally {
    clearTimeout(t);
  }
}

// One companyfacts.json fetch per CIK returns EVERY concept. Massively
// faster than per-concept queries when we check 4 revenue-concept
// variants. Cached across the run.
const cikCache = new Map();
async function fetchSecFacts(cik) {
  const padded = padCik(cik);
  if (cikCache.has(padded)) return cikCache.get(padded);
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  const { status, body } = await fetchJson(url);
  if (status !== 200 || !body) {
    cikCache.set(padded, []);
    return [];
  }
  const facts = body.facts ?? {};
  const allFacts = [];
  for (const c of CONCEPTS) {
    const item = facts?.[c.taxo]?.[c.key];
    if (!item) continue;
    const units = item.units ?? {};
    for (const [unit, values] of Object.entries(units)) {
      for (const v of values) allFacts.push({ ...v, _unit: unit, _concept: `${c.taxo}:${c.key}` });
    }
  }
  cikCache.set(padded, allFacts);
  return allFacts;
}

function pickMatchingFact(facts, event) {
  // The reliable match is on SEC `filed` date proximity to event.eventDate
  // (which is the 10-Q's filing date). SEC returns each pure-quarter fact
  // TWICE — once as the reporting quarter in year Y's filing, and again
  // as the prior-year comparative in year Y+1's filing. Both carry
  // pure-quarter spans but different fy labels. The filing date is
  // unique-ish per event.
  //
  // Pick: pure-quarter USD facts whose SEC filed date is within ±3 days
  // of the event.eventDate. Among those, take the one whose `end` is
  // strictly BEFORE filed (i.e. the current reporting quarter, not the
  // year-old comparative which would have an end 12 months earlier).
  if (!event.eventDate) return null;
  const eventTs = new Date(event.eventDate).getTime();
  const usd = facts.filter((f) => isPureQuarter(f) && f._unit === "USD" && f.filed);
  const byFiled = usd.filter((f) => {
    const filedTs = new Date(f.filed).getTime();
    return Math.abs(filedTs - eventTs) <= 3 * 86_400_000;
  });
  if (byFiled.length === 0) return null;
  // Among facts filed at this event's date, prefer the one whose `end`
  // is closest to filed (the current quarter, ~30-90 days before file).
  // Prior-year comparatives have `end` ~365d before filed.
  byFiled.sort((a, b) => {
    const aDelta = new Date(a.filed).getTime() - new Date(a.end).getTime();
    const bDelta = new Date(b.filed).getTime() - new Date(b.end).getTime();
    return aDelta - bDelta;
  });
  return byFiled[0];
}

async function main() {
  const startedAt = new Date().toISOString();
  const reg = JSON.parse(await fs.readFile(REG, "utf-8"));
  const entities = reg.entities ?? [];
  const cikEntities = entities.filter(
    (e) => e.securityType === "operating" && e.edgarCik && (!ONLY_TICKER || e.ticker === ONLY_TICKER),
  );
  console.log(`revenue-reality-check · ${startedAt}`);
  console.log(`  CIK-bearing operating tickers: ${cikEntities.length}`);
  console.log(`  concepts probed per CIK: ${CONCEPTS.length}`);
  console.log(`  delta flag threshold: ${DELTA_FLAG_PCT}%`);
  console.log("");

  const capped = LIMIT !== Infinity ? cikEntities.slice(0, LIMIT) : cikEntities;
  const findings = [];
  const totals = {
    tickers_checked: 0,
    tickers_with_no_sec_facts: 0,
    events_checked: 0,
    events_matched: 0,
    events_no_match: 0,
    events_flagged: 0,
    events_missing_stored_revenue: 0,
  };

  for (const e of capped) {
    totals.tickers_checked++;
    // Read shard
    let shard;
    try {
      shard = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, `${tickerSlug(e.ticker)}.json`), "utf-8"));
    } catch { continue; }
    const events = (Array.isArray(shard) ? shard : shard.events ?? [])
      .filter((ev) => ev.eventDate && ev.period)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""))
      .slice(0, 8); // latest 8 past events — 2 years of quarters
    if (events.length === 0) continue;

    const secFacts = await fetchSecFacts(e.edgarCik);
    if (!secFacts || secFacts.length === 0) {
      totals.tickers_with_no_sec_facts++;
      continue;
    }
    for (const ev of events) {
      totals.events_checked++;
      const stored = (ev.metrics ?? []).find((m) => m.key === "revenue_usd_m")?.actual?.value ?? null;
      if (stored == null) { totals.events_missing_stored_revenue++; continue; }
      const secFact = pickMatchingFact(secFacts, ev);
      if (!secFact) { totals.events_no_match++; continue; }
      totals.events_matched++;
      // Shard stores revenue in millions ('_m' suffix on key); SEC returns
      // full USD. Convert SEC to millions for the compare.
      const secMillions = secFact.val / 1e6;
      const deltaPct = ((stored - secMillions) / Math.abs(secMillions)) * 100;
      if (Math.abs(deltaPct) > DELTA_FLAG_PCT) {
        totals.events_flagged++;
        findings.push({
          ticker: e.ticker,
          cik: padCik(e.edgarCik),
          period: ev.period,
          eventDate: ev.eventDate,
          storedValueM: stored,
          secValueM: Number(secMillions.toFixed(1)),
          deltaPct: Number(deltaPct.toFixed(1)),
          storedProvenance: (ev.metrics ?? []).find((m) => m.key === "revenue_usd_m")?.actual?.source?.label ?? null,
          secConcept: secFact._concept,
          secFiled: secFact.filed,
          secForm: secFact.form,
        });
      }
    }
    if (totals.tickers_checked % 50 === 0) {
      const pct = ((totals.tickers_checked / capped.length) * 100).toFixed(0);
      console.log(`  ${totals.tickers_checked}/${capped.length} (${pct}%) · flagged so far: ${totals.events_flagged}`);
    }
  }

  // Sort findings by absolute delta descending — worst offenders first.
  findings.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

  const out = {
    schema: "revenue-reality-check/v1",
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    delta_flag_pct_threshold: DELTA_FLAG_PCT,
    totals,
    worst_offenders_top_20: findings.slice(0, 20),
    findings,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n=== done ===`);
  console.log(`  tickers checked:       ${totals.tickers_checked}`);
  console.log(`  no SEC facts:          ${totals.tickers_with_no_sec_facts}`);
  console.log(`  events checked:        ${totals.events_checked}`);
  console.log(`  events matched:        ${totals.events_matched}`);
  console.log(`  events no match:       ${totals.events_no_match}`);
  console.log(`  events flagged (>${DELTA_FLAG_PCT}%): ${totals.events_flagged}`);
  console.log(`  wrote → ${path.relative(ROOT, OUT_PATH)}`);
  if (findings.length > 0) {
    console.log(`\n  top 5 worst deltas:`);
    for (const f of findings.slice(0, 5)) {
      console.log(`    ${f.ticker.padEnd(12)} ${f.period.padEnd(10)} stored=${f.storedValueM}M sec=${f.secValueM}M Δ=${f.deltaPct}%`);
    }
  }
}

main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
