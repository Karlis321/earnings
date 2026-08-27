#!/usr/bin/env node
/**
 * Fix event.period labels that don't match SEC's fy+fp for the
 * filing.
 *
 * Bug found by pipeline-report `companies_with_inconsistent_financials`
 * on 2026-08-26: 10 US canonicals label the July-filed 10-Q as
 * FY2026 Q2 when SEC records it as FY2026 Q3 (AAPL, HD, CSCO, AMAT,
 * ARG US + 5 more). Cross-listing invariant then fires because the
 * international siblings (which correctly label it Q3) show
 * different revenue for the same (companyId, period) group.
 *
 * For each CIK-bearing operating event on the current shard state:
 *   1. Read event.eventDate (10-Q filing date) + event.period
 *   2. Fetch SEC companyfacts, find the fact matching this filed
 *      date via ±3-day proximity, prefer smallest (filed-end) gap
 *      (same match logic as rederive-sec-xbrl.mjs's
 *      extractQuarterValues)
 *   3. Read the fact's `fy` and `fp` — the SEC-truth fiscal label
 *   4. Compare to event.period. If different, rewrite the period.
 *
 * READ + WRITE. Only rewrites period on events where SEC has a
 * matching quarterly fact and the label disagrees. Preserves all
 * other fields. Writes a per-CIK sample audit to
 * scripts/audits/fix-period-labels-from-sec.json.
 *
 *   node scripts/backfills/fix-period-labels-from-sec.mjs --dry
 *   node scripts/backfills/fix-period-labels-from-sec.mjs --cik=320193
 *   node scripts/backfills/fix-period-labels-from-sec.mjs
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const AUDIT_OUT = path.join(ROOT, "scripts", "audits", "fix-period-labels-from-sec.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const CIK_FILTER = args.get("cik")
  ? new Set(String(args.get("cik")).split(",").map((c) => String(parseInt(c, 10))))
  : null;

const UA = `Earnings Tracker (${process.env.EDGAR_CONTACT_EMAIL || "klpp@bluorbank.lv"})`;
const REQ_TIMEOUT_MS = 15_000;
const RATE_LIMIT_MS = 500;

function padCik(cik) { return String(cik).replace(/^CIK/i, "").padStart(10, "0"); }
function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function isPureQuarter(v) {
  if (!v.start || !v.end) return false;
  const span = (new Date(v.end).getTime() - new Date(v.start).getTime()) / 86_400_000;
  return span >= 80 && span <= 100;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return { status: r.status, body: null };
    return { status: 200, body: await r.json() };
  } catch (e) { return { status: 0, body: null, err: e.message }; }
  finally { clearTimeout(t); }
}

// Consolidate all pure-quarter Revenue facts across concept variants
// into one array. Same fallback chain as revenue-reality-check.
async function fetchQuarterlyRevenueFacts(cik) {
  const padded = padCik(cik);
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  const { status, body } = await fetchJson(url);
  if (status !== 200 || !body) return [];
  const CONCEPTS = [
    ["us-gaap", "Revenues"],
    ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"],
    ["us-gaap", "SalesRevenueNet"],
    ["ifrs-full", "Revenue"],
  ];
  const all = [];
  for (const [taxo, key] of CONCEPTS) {
    const item = body.facts?.[taxo]?.[key];
    if (!item) continue;
    const usd = item.units?.USD ?? [];
    for (const v of usd) {
      if (!isPureQuarter(v)) continue;
      if (!v.filed || !v.fy || !v.fp) continue;
      all.push({ ...v, _taxo: taxo, _key: key });
    }
  }
  return all;
}

// Given SEC facts + an event's filing date, return the reporting-
// quarter fact (fy+fp of the CURRENT quarter, not the year-old
// comparative that shares the same filed date).
function pickReportingQuarter(facts, eventDate) {
  if (!eventDate) return null;
  const eventMs = new Date(eventDate).getTime();
  const candidates = facts.filter((f) => {
    const filedDelta = Math.abs(new Date(f.filed).getTime() - eventMs) / 86_400_000;
    return filedDelta <= 3;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aGap = new Date(a.filed).getTime() - new Date(a.end).getTime();
    const bGap = new Date(b.filed).getTime() - new Date(b.end).getTime();
    return aGap - bGap;
  });
  return candidates[0];
}

async function main() {
  const startedAt = new Date().toISOString();
  const reg = JSON.parse(await fs.readFile(REG, "utf-8"));
  const entities = reg.entities ?? [];
  const targets = entities.filter((e) => {
    if (!e.edgarCik || e.securityType !== "operating") return false;
    if (CIK_FILTER) {
      const cik = String(parseInt(e.edgarCik, 10));
      return CIK_FILTER.has(cik);
    }
    return true;
  });
  console.log(`fix-period-labels-from-sec · ${startedAt}`);
  console.log(`  dry=${DRY} · targeted tickers: ${targets.length}`);

  // Group targets by CIK — one companyfacts fetch per CIK, then apply
  // the fix to every listing under that CIK.
  const byCik = new Map();
  for (const e of targets) {
    const cik = String(parseInt(e.edgarCik, 10));
    if (!byCik.has(cik)) byCik.set(cik, []);
    byCik.get(cik).push(e);
  }
  console.log(`  unique CIKs: ${byCik.size}\n`);

  const stats = { tickers_checked: 0, events_checked: 0, events_relabeled: 0, events_no_match: 0, ciks_no_facts: 0 };
  const samples = [];
  let processed = 0;

  for (const [cik, listings] of byCik) {
    processed++;
    const facts = await fetchQuarterlyRevenueFacts(cik);
    if (facts.length === 0) { stats.ciks_no_facts++; continue; }
    for (const entity of listings) {
      stats.tickers_checked++;
      const p = path.join(EVENTS_DIR, `${tickerSlug(entity.ticker)}.json`);
      let shard;
      try { shard = JSON.parse(await fs.readFile(p, "utf-8")); } catch { continue; }
      const wrapped = !Array.isArray(shard);
      const events = wrapped ? (shard.events ?? []) : shard;
      let mutated = false;
      for (const ev of events) {
        if (!ev.eventDate || !ev.period) continue;
        stats.events_checked++;
        const secFact = pickReportingQuarter(facts, ev.eventDate);
        if (!secFact) { stats.events_no_match++; continue; }
        const secPeriod = `FY${secFact.fy} ${secFact.fp}`;
        if (secPeriod === ev.period) continue;
        // Only relabel when the SEC label makes sense (Q1-Q4 or FY).
        if (!/^Q[1-4]$|^FY$/.test(secFact.fp)) continue;
        if (samples.length < 40) {
          samples.push({
            ticker: entity.ticker,
            cik: padCik(cik),
            eventDate: ev.eventDate,
            oldPeriod: ev.period,
            newPeriod: secPeriod,
            secEnd: secFact.end,
            secFiled: secFact.filed,
          });
        }
        ev.period = secPeriod;
        stats.events_relabeled++;
        mutated = true;
      }
      if (mutated && !DRY) {
        const body = wrapped ? { ...shard, events } : events;
        fssync.writeFileSync(p, JSON.stringify(body, null, 2));
      }
    }
    if (processed % 20 === 0) {
      console.log(`  ${processed}/${byCik.size} CIKs · relabeled ${stats.events_relabeled} events across ${stats.tickers_checked} tickers`);
    }
  }

  const audit = {
    schema: "fix-period-labels-from-sec/v1",
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    dry: DRY,
    stats,
    samples,
  };
  await fs.writeFile(AUDIT_OUT, JSON.stringify(audit, null, 2));

  console.log(`\n=== done ===`);
  console.log(`  tickers checked:    ${stats.tickers_checked}`);
  console.log(`  events checked:     ${stats.events_checked}`);
  console.log(`  events no-match:    ${stats.events_no_match}`);
  console.log(`  events relabeled:   ${stats.events_relabeled}`);
  console.log(`  ciks no SEC facts:  ${stats.ciks_no_facts}`);
  console.log(`  audit → ${path.relative(ROOT, AUDIT_OUT)}`);
  if (samples.length > 0) {
    console.log(`\n  sample corrections (first 10):`);
    for (const s of samples.slice(0, 10)) {
      console.log(`    ${s.ticker.padEnd(12)} ${s.eventDate} · ${s.oldPeriod.padEnd(10)} → ${s.newPeriod.padEnd(10)} (SEC end=${s.secEnd})`);
    }
  }
}
main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
