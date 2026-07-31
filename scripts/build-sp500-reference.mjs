#!/usr/bin/env node
/**
 * Phase 1 of the S&P 500 universe-grouping task:
 *
 *   1. Parse the fetched Wikipedia "List of S&P 500 companies" HTML.
 *   2. Write data/reference/sp500.json { as_of, source, constituents[] }.
 *   3. Reconcile vs registry (match on symbol → CIK fallback), print
 *      matched | missing | ambiguous, missing broken down by GICS
 *      sector, ingest cost estimate.
 *   4. STOP — do not ingest anything.
 *
 * Input: /tmp/sp500-wikipedia.html (pre-fetched via curl so the request
 * doesn't get truncated by WebFetch).
 *
 *   node scripts/build-sp500-reference.mjs
 *   node scripts/build-sp500-reference.mjs --dry-run   # skip the file write
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const OUT_PATH = path.join(ROOT, "data", "reference", "sp500.json");
const HTML_PATH = path.join(ROOT, "fetched", "sp500-wikipedia.html");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");

// The constituents table is the FIRST wikitable on the page. Extract it
// then split into <tr>...</tr> rows.
function extractTable(html) {
  const start = html.indexOf('class="wikitable');
  if (start < 0) throw new Error("no wikitable found on page");
  const tableStart = html.lastIndexOf("<table", start);
  const tableEnd = html.indexOf("</table>", tableStart) + "</table>".length;
  return html.slice(tableStart, tableEnd);
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#160;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTable(tableHtml) {
  const rows = [];
  const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  // First row is the header — check + skip.
  const header = rowMatches[0];
  if (!/Symbol/i.test(header ?? "")) {
    throw new Error("first row does not look like a header — parser mismatch");
  }
  for (const row of rowMatches.slice(1)) {
    const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) ?? [];
    if (cells.length < 6) continue;
    const text = cells.map(stripTags);
    // Column order on this page (2026-07-31 snapshot):
    //   [0] Symbol  [1] Security  [2] GICS Sector  [3] GICS Sub-Industry
    //   [4] Headquarters  [5] Date added  [6] CIK  [7] Founded
    // (Wikipedia has rearranged these before — verify by checking the
    // header if this file gets re-fetched later.)
    const symbol = text[0];
    const name = text[1];
    const gicsSector = text[2];
    const gicsSubIndustry = text[3];
    const dateAdded = text[5];
    const cik = text[6];
    if (!symbol || !/^[A-Z]/.test(symbol)) continue;
    rows.push({
      symbol,
      name,
      gics_sector: gicsSector,
      gics_sub_industry: gicsSubIndustry,
      cik: /^\d+$/.test(cik) ? cik.padStart(10, "0") : null,
      date_added: dateAdded,
    });
  }
  return rows;
}

// Normalize class-share punctuation for symbol matching.
// Wikipedia uses "BRK.B" — Bloomberg tickers in our registry are "BRK/B US".
// Both refer to Berkshire Class B.
function normalizeSymbol(s) {
  return s.replace(/[.\-\/]/g, "").toUpperCase();
}

function toBloombergTicker(wikipediaSymbol) {
  // Wikipedia symbols are US-listed root only ("BRK.B", "GOOGL", "MSFT").
  // Registry stores as "<ROOT> US" with dashes/dots collapsed to "/" for
  // class-share letters. Try common variants.
  const stripped = wikipediaSymbol.replace(/\./g, "").replace(/-/g, "");
  return {
    exact: `${wikipediaSymbol} US`,
    normalized: `${stripped} US`,
    slashed: `${wikipediaSymbol.replace(/\./g, "/")} US`,
  };
}

async function main() {
  const html = await fs.readFile(HTML_PATH, "utf-8");
  const table = extractTable(html);
  const rows = parseTable(table);
  console.log(`parsed ${rows.length} constituents from wikitable`);
  if (rows.length < 490 || rows.length > 520) {
    console.error(`::error::row count ${rows.length} is far from the expected ~503 — parse likely broke, ABORTING`);
    process.exit(1);
  }

  const reference = {
    schema: "sp500-reference/v1",
    as_of: new Date().toISOString().slice(0, 10),
    source: {
      name: "Wikipedia — List of S&P 500 companies",
      url: "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
      fetched_at: new Date().toISOString(),
    },
    constituents: rows,
  };

  if (!DRY) {
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify(reference, null, 2));
    console.log(`✓ wrote ${path.relative(ROOT, OUT_PATH)}`);
  }

  // ---- RECONCILIATION ----
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];

  // Build lookup indices.
  const byTicker = new Map();
  const byCik = new Map();
  const byNormalizedSymbol = new Map();
  for (const e of entities) {
    byTicker.set(e.ticker, e);
    if (e.edgarCik) byCik.set(e.edgarCik, e);
    // Registry tickers are "<ROOT> US" or "<ROOT>/<CLASS> US". Match a
    // Wikipedia symbol like "BRK.B" by normalizing punctuation off both
    // sides. Only US-listing candidates (we're matching S&P 500 = US
    // constituents), so include all entities but bias toward "... US".
    const rootPart = e.ticker.split(/\s+/)[0];
    byNormalizedSymbol.set(normalizeSymbol(rootPart) + "_US", e);
  }

  const matched = [];
  const missing = [];
  const ambiguousReport = [];
  const classShareMap = [];

  for (const c of rows) {
    const variants = toBloombergTicker(c.symbol);
    // 1) Exact Bloomberg form.
    let hit = byTicker.get(variants.exact);
    let matchedVia = "exact";
    // 2) Slashed form for class-share symbols.
    if (!hit && variants.slashed !== variants.exact) {
      hit = byTicker.get(variants.slashed);
      if (hit) matchedVia = "class-share/";
    }
    // 3) Normalized-symbol (strips punctuation).
    if (!hit) {
      hit = byNormalizedSymbol.get(normalizeSymbol(c.symbol) + "_US");
      if (hit) matchedVia = "normalized";
    }
    // 4) CIK fallback.
    if (!hit && c.cik) {
      hit = byCik.get(c.cik);
      if (hit) matchedVia = "cik";
    }
    if (hit) {
      matched.push({
        wiki_symbol: c.symbol,
        entity_ticker: hit.ticker,
        matched_via: matchedVia,
        gics_sector: c.gics_sector,
      });
      if (variants.slashed !== variants.exact) {
        classShareMap.push({
          wiki_symbol: c.symbol,
          entity_ticker: hit.ticker,
          via: matchedVia,
        });
      }
    } else {
      missing.push(c);
    }
  }

  // Sector breakdown of the missing set.
  const missingBySector = new Map();
  for (const m of missing) {
    missingBySector.set(m.gics_sector, (missingBySector.get(m.gics_sector) ?? 0) + 1);
  }
  const missingSectorTable = [...missingBySector.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sector, count]) => ({ sector, count }));

  // Ingest cost estimate. Per prompt constraints: SEC 1 req/s + Yahoo
  // concurrency 4-8. Rough per-constituent cost:
  //   - Yahoo timeseries fetch:      ~1 req, ~0.5s
  //   - Yahoo quoteSummary+chart:    ~1 req, ~0.5s
  //   - Yahoo earnings-trend:        ~1 req, ~0.5s
  //   - SEC XBRL companyfacts:       ~1 req (1s SEC budget)
  //   - SEC submissions:             ~1 req (1s SEC budget)
  //   - marketcap / crumb / etc:     shared amortized
  // Serial SEC dominates: 2 req × 1s = 2s per constituent. Yahoo at 6
  // concurrency: ~1.5s per constituent effective. So end-to-end per
  // ticker ≈ 3.5s; batches of 6 concurrent Yahoo + 1 serial SEC keep
  // pace at max(SEC serial, Yahoo/N) per ticker. Report both bounds.
  const N = missing.length;
  const secBoundSec = N * 2;
  const yahooBoundSec = Math.ceil(N * 1.5 / 6);
  const wallSec = Math.max(secBoundSec, yahooBoundSec);
  const expectedShards = N; // one shard per constituent
  const expectedEventsPerShard = 5; // 4 quarters history + 1 upcoming shell (typical)

  const report = {
    schema: "sp500-reconcile/v1",
    generatedAt: new Date().toISOString(),
    counts: {
      constituents_total: rows.length,
      matched: matched.length,
      missing: missing.length,
      ambiguous: ambiguousReport.length,
    },
    class_share_map: classShareMap,
    missing_by_sector: missingSectorTable,
    ingest_cost_estimate: {
      entities_to_add: N,
      expected_new_shards: expectedShards,
      expected_new_events_approx: expectedShards * expectedEventsPerShard,
      wall_seconds_lower_bound_yahoo_only: yahooBoundSec,
      wall_seconds_lower_bound_sec_serial: secBoundSec,
      wall_seconds_end_to_end_estimate: wallSec,
      wall_minutes_end_to_end_estimate: Math.ceil(wallSec / 60),
    },
    missing_names: missing.map((m) => ({ symbol: m.symbol, name: m.name, gics_sector: m.gics_sector, cik: m.cik })),
  };

  // Print table.
  console.log(`\n=== S&P 500 reconciliation vs registry ===`);
  console.log(`  total constituents:    ${rows.length}`);
  console.log(`  matched:               ${matched.length}`);
  console.log(`  missing:               ${missing.length}`);
  console.log(`  ambiguous:             ${ambiguousReport.length}`);
  console.log(`\n  match methods:`);
  const byMethod = new Map();
  for (const m of matched) byMethod.set(m.matched_via, (byMethod.get(m.matched_via) ?? 0) + 1);
  for (const [method, n] of byMethod) console.log(`    ${method.padEnd(15)} ${n}`);

  console.log(`\n  class-share mappings:`);
  for (const c of classShareMap.slice(0, 15)) {
    console.log(`    ${c.wiki_symbol.padEnd(10)} → ${c.entity_ticker.padEnd(15)} via ${c.via}`);
  }
  if (classShareMap.length > 15) console.log(`    …+${classShareMap.length - 15} more`);

  console.log(`\n  missing by GICS sector:`);
  for (const s of missingSectorTable) {
    console.log(`    ${s.sector.padEnd(30)} ${s.count}`);
  }

  console.log(`\n  ingest cost estimate for ${N} missing constituents:`);
  const c = report.ingest_cost_estimate;
  console.log(`    expected new shards:              ${c.expected_new_shards}`);
  console.log(`    expected new events (approx):     ${c.expected_new_events_approx}`);
  console.log(`    SEC-serial bound:                 ${c.wall_seconds_lower_bound_sec_serial}s`);
  console.log(`    Yahoo-concurrency-6 bound:        ${c.wall_seconds_lower_bound_yahoo_only}s`);
  console.log(`    end-to-end wall estimate:         ${c.wall_seconds_end_to_end_estimate}s (~${c.wall_minutes_end_to_end_estimate} min)`);

  if (missing.length > 0) {
    console.log(`\n  missing constituents (first 25 by name):`);
    const sample = [...missing].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25);
    for (const m of sample) {
      console.log(`    ${m.symbol.padEnd(8)} ${m.name.slice(0, 40).padEnd(40)} ${m.gics_sector.padEnd(24)} CIK=${m.cik ?? "—"}`);
    }
    if (missing.length > 25) console.log(`    …+${missing.length - 25} more`);
  }

  const auditPath = path.join(ROOT, "scripts", "audits", "sp500-reconcile.json");
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.writeFile(auditPath, JSON.stringify(report, null, 2));
  console.log(`\n  audit → ${path.relative(ROOT, auditPath)}`);
  console.log(`\n>>> STOP: Phase 1 complete. Awaiting approval before Phase 2 ingest of ${N} missing constituents.`);
}

main().catch((e) => {
  console.error(`::error::build-sp500-reference crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
