#!/usr/bin/env node
/**
 * Backfill event.sourceLink on every event across every shard.
 *
 * Rules (mirror frontend/server/lib/cronDetections.ts::computeSourceLink):
 *   sec-submissions       → filing URL on filing_reference metric   → filing
 *   sec-xbrl-companyfacts → EDGAR filings index for CIK+form        → fallback
 *   yahoo-timeseries      → Yahoo financials page                   → fallback
 *   yahoo-earnings-chart  → Yahoo financials page                   → fallback
 *   fmp                   → FMP income-statement page               → fallback
 *   estimator-median-gap  → null
 *   manual-entry, fixture → null
 *
 * Walks data/events/*.json (each shard is {schema, ticker, events}),
 * computes sourceLink per event, writes back. Also patches data/earnings.json
 * so anything still reading the monolith stays consistent.
 *
 *   node scripts/backfill-source-links.mjs
 *   node scripts/backfill-source-links.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");

function computeSourceLink(event, entity) {
  const prov = event.provenance;
  const symbol = entity?.yahooSymbol ?? event.ticker?.split(/\s+/)[0];

  if (prov === "sec-submissions") {
    const fr = (event.metrics ?? []).find((m) => m.key === "filing_reference");
    const url = fr?.actual?.source?.url ?? null;
    if (url) return { url, kind: "filing" };
  }

  if (prov === "sec-xbrl-companyfacts") {
    if (!entity?.edgarCik) return null;
    const paddedCik = String(entity.edgarCik).padStart(10, "0");
    const isFiscalYear = /^FY\d{4}$/.test((event.period ?? "").trim());
    const type = isFiscalYear ? "10-K" : "10-Q";
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(type)}&dateb=&owner=include&count=40`;
    return { url, kind: "fallback" };
  }

  if (prov === "yahoo-timeseries" || prov === "yahoo-earnings-chart") {
    if (!symbol) return null;
    return {
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials`,
      kind: "fallback",
    };
  }

  if (prov === "fmp") {
    if (!symbol) return null;
    return {
      url: `https://financialmodelingprep.com/financial-statements/${encodeURIComponent(symbol)}`,
      kind: "fallback",
    };
  }
  return null;
}

async function main() {
  console.log(`backfill-source-links · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const entityByTicker = new Map(reg.entities.map((e) => [e.ticker, e]));

  const shardFiles = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  let totalEvents = 0;
  let filing = 0;
  let fallback = 0;
  let none = 0;
  let stampedNow = 0;
  const noneByProv = new Map();

  const shardWrites = [];
  for (const f of shardFiles) {
    const p = path.join(EVENTS_DIR, f);
    const raw = await fs.readFile(p, "utf-8");
    const j = JSON.parse(raw);
    const evs = Array.isArray(j) ? j : (j.events ?? []);
    if (evs.length === 0) continue;
    const entity = entityByTicker.get(evs[0].ticker);
    let changed = false;
    for (const ev of evs) {
      totalEvents++;
      const link = computeSourceLink(ev, entity);
      if (!link) {
        none++;
        const key = ev.provenance ?? "(none)";
        noneByProv.set(key, (noneByProv.get(key) ?? 0) + 1);
      } else if (link.kind === "filing") filing++;
      else fallback++;
      // Only rewrite if the current value differs.
      const cur = ev.sourceLink ?? null;
      const same =
        (cur === null && link === null) ||
        (cur &&
          link &&
          cur.url === link.url &&
          cur.kind === link.kind);
      if (!same) {
        ev.sourceLink = link;
        changed = true;
        stampedNow++;
      }
    }
    if (changed) {
      const body = Array.isArray(j) ? evs : { ...j, events: evs };
      shardWrites.push({ path: p, body: JSON.stringify(body, null, 2) });
    }
  }

  // Also patch data/earnings.json so any legacy reader sees the field.
  let monoStamped = 0;
  let monoBody = null;
  try {
    const monoRaw = await fs.readFile(EARNINGS, "utf-8");
    const mono = JSON.parse(monoRaw);
    for (const ev of mono.events ?? []) {
      const entity = entityByTicker.get(ev.ticker);
      const link = computeSourceLink(ev, entity);
      const cur = ev.sourceLink ?? null;
      const same =
        (cur === null && link === null) ||
        (cur && link && cur.url === link.url && cur.kind === link.kind);
      if (!same) {
        ev.sourceLink = link;
        monoStamped++;
      }
    }
    monoBody = JSON.stringify(mono, null, 2);
  } catch {
    // earnings.json is optional (kept locally / gitignored per CLAUDE.md).
  }

  console.log(`Shards scanned:  ${shardFiles.length}`);
  console.log(`Events total:    ${totalEvents}`);
  console.log(`  filing links:  ${filing}`);
  console.log(`  fallback:      ${fallback}`);
  console.log(`  none (null):   ${none}`);
  console.log(`Shards updated:  ${shardWrites.length}`);
  console.log(`Events stamped:  ${stampedNow} (${monoStamped} in monolith)`);

  if (none > 0) {
    console.log(`\n"none" breakdown by provenance:`);
    for (const [k, n] of [...noneByProv].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(k).padEnd(28)} ${n}`);
    }
  }

  if (DRY) {
    console.log("\nDry run — no write.");
    return;
  }

  for (const w of shardWrites) await fs.writeFile(w.path, w.body);
  if (monoBody !== null) await fs.writeFile(EARNINGS, monoBody);
  console.log(`\n✓ wrote ${shardWrites.length} shards${monoBody !== null ? " + earnings.json" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
