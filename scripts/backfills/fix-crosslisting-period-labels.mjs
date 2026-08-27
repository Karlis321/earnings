#!/usr/bin/env node
/**
 * Cross-sibling period-label repair for companies where the
 * cross-listing invariant fires because one listing has an event
 * mis-labeled by 1 quarter.
 *
 * Pattern (surfaced 2026-08-27 on Arko, Figma, AES, 967316):
 *   FIG1 MM   FY2025 Q3 · 274.173  <-- 2 siblings agree
 *   1S2 GR    FY2025 Q3 · 274.173  <-- 2 siblings agree
 *   1FIG IM   FY2025 Q4 · 274.173  <-- one sibling has value on WRONG period
 *
 * When a value appears on N siblings tagged with one period label
 * and on M siblings (N>=1, M>=1) tagged with a different period
 * label, and the majority wins by cross-checking a nearby quarter's
 * value chain (same value = same quarter), relabel the minority to
 * match the majority.
 *
 * READ + WRITE. Audit trail at scripts/audits/fix-crosslisting-period-labels.json.
 *
 *   node scripts/backfills/fix-crosslisting-period-labels.mjs --dry
 *   node scripts/backfills/fix-crosslisting-period-labels.mjs
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
const OUT = path.join(ROOT, "scripts", "audits", "fix-crosslisting-period-labels.json");

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const DRY = args.get("dry") === true;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  const reg = JSON.parse(await fs.readFile(REG, "utf-8"));
  const byCid = new Map();
  for (const e of reg.entities ?? []) {
    if (!e.companyId) continue;
    if (!byCid.has(e.companyId)) byCid.set(e.companyId, []);
    byCid.get(e.companyId).push(e);
  }

  const relabels = [];
  const stats = {
    companies_checked: 0,
    companies_with_relabels: 0,
    events_relabeled: 0,
  };

  for (const [cid, members] of byCid) {
    if (members.length < 2) continue;
    stats.companies_checked++;

    // Load every past-event revenue across all listings, key by ticker.
    // Map: ticker -> Map(period -> {rev, eventDate, evRef, shardBody, wrapped})
    const byTicker = new Map();
    for (const m of members) {
      const p = path.join(EVENTS_DIR, `${tickerSlug(m.ticker)}.json`);
      let shard;
      try { shard = JSON.parse(await fs.readFile(p, "utf-8")); } catch { continue; }
      const wrapped = !Array.isArray(shard);
      const events = wrapped ? (shard.events ?? []) : shard;
      const perPeriod = new Map();
      for (const ev of events) {
        if (!ev.eventDate || !ev.period) continue;
        const revMetric = (ev.metrics ?? []).find((x) => x.key === "revenue_usd_m");
        const rev = revMetric?.actual?.value;
        const unit = revMetric?.actual?.unit;
        if (rev == null || unit !== "USD") continue;
        perPeriod.set(ev.period, { rev, eventDate: ev.eventDate, evRef: ev });
      }
      byTicker.set(m.ticker, { perPeriod, shardPath: p, shardBody: shard, wrapped, events });
    }

    // Build a value→periods map across ALL listings.
    // valueMap: revenueValue(rounded to 3dp) -> Map(period -> [tickers])
    const valueMap = new Map();
    for (const [ticker, { perPeriod }] of byTicker) {
      for (const [period, { rev }] of perPeriod) {
        const k = String(Math.round(rev * 1000));
        if (!valueMap.has(k)) valueMap.set(k, new Map());
        const pmap = valueMap.get(k);
        if (!pmap.has(period)) pmap.set(period, []);
        pmap.get(period).push(ticker);
      }
    }

    // For each unique value: if it appears with MORE than one period
    // label AND at least one label has a strict majority (2+ tickers)
    // AND the minority label has fewer tickers, relabel the minority.
    let companyRelabels = 0;
    for (const [valKey, pmap] of valueMap) {
      if (pmap.size < 2) continue;
      const pairs = [...pmap.entries()];
      pairs.sort((a, b) => b[1].length - a[1].length);
      const [majorityPeriod, majorityTickers] = pairs[0];
      if (majorityTickers.length < 2) continue;
      for (let i = 1; i < pairs.length; i++) {
        const [minorityPeriod, minorityTickers] = pairs[i];
        if (minorityTickers.length >= majorityTickers.length) continue;
        for (const minTicker of minorityTickers) {
          const meta = byTicker.get(minTicker);
          if (!meta) continue;
          // Skip if the minority ticker ALSO has an event with the
          // majority period (would create a duplicate).
          if (meta.perPeriod.has(majorityPeriod)) continue;
          // Find the event object and relabel
          const target = meta.events.find((e) => e.period === minorityPeriod && Math.round(((e.metrics ?? []).find((x) => x.key === "revenue_usd_m")?.actual?.value ?? 0) * 1000) === parseInt(valKey, 10));
          if (!target) continue;
          relabels.push({
            companyId: cid,
            ticker: minTicker,
            eventDate: target.eventDate,
            oldPeriod: minorityPeriod,
            newPeriod: majorityPeriod,
            value: Number((parseInt(valKey, 10) / 1000).toFixed(3)),
            supportingSiblings: majorityTickers,
          });
          target.period = majorityPeriod;
          companyRelabels++;
          stats.events_relabeled++;
        }
      }
    }

    if (companyRelabels > 0) {
      stats.companies_with_relabels++;
      if (!DRY) {
        // Write each touched shard once
        const written = new Set();
        for (const [ticker, meta] of byTicker) {
          if (written.has(meta.shardPath)) continue;
          const body = meta.wrapped ? { ...meta.shardBody, events: meta.events } : meta.events;
          fssync.writeFileSync(meta.shardPath, JSON.stringify(body, null, 2));
          written.add(meta.shardPath);
        }
      }
    }
  }

  const audit = {
    schema: "fix-crosslisting-period-labels/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    stats,
    relabels,
  };
  await fs.writeFile(OUT, JSON.stringify(audit, null, 2));

  console.log(`\n=== done ===`);
  console.log(`  companies checked:      ${stats.companies_checked}`);
  console.log(`  companies with relabel: ${stats.companies_with_relabels}`);
  console.log(`  events relabeled:       ${stats.events_relabeled}`);
  console.log(`  audit → ${path.relative(ROOT, OUT)}`);
  if (relabels.length > 0) {
    console.log(`\n  sample corrections (first 10):`);
    for (const r of relabels.slice(0, 10)) {
      console.log(`    ${r.ticker.padEnd(12)} ${r.eventDate} · ${r.oldPeriod.padEnd(10)} → ${r.newPeriod.padEnd(10)} (rev=${r.value}, matches ${r.supportingSiblings.slice(0, 2).join(", ")})`);
    }
  }
}
main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
