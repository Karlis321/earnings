#!/usr/bin/env node
/**
 * Fetch + parse Wikipedia's "Russell 1000 Index" constituents table
 * → data/reference/russell1000.json { as_of, source, constituents }.
 * Then reconcile vs the registry (same shape as sp500 reconcile).
 *
 * Wikipedia's constituent table for Russell 1000 has columns:
 *   Company · Symbol · GICS Sector · GICS Sub-Industry
 * (No CIK column — the R1000 wiki page is thinner than the SP500 one.
 * CIK auto-resolve happens later via scripts/resolve-missing-ciks.mjs
 * when the entities are registered.)
 *
 *   node scripts/build-russell1000-reference.mjs
 *   node scripts/build-russell1000-reference.mjs --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const OUT_PATH = path.join(ROOT, "data", "reference", "russell1000.json");
const HTML_PATH = path.join(ROOT, "fetched", "russell1000-wikipedia.html");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");

function extractConstituentsTable(html) {
  // The R1000 page can have multiple wikitables (also year-by-year
  // change history). The CONSTITUENTS table is the one whose header
  // row contains both "Symbol" and "GICS Sector". Scan every table
  // and return the matching one.
  const tables = [];
  let idx = 0;
  while (true) {
    const start = html.indexOf('class="wikitable', idx);
    if (start < 0) break;
    const tableStart = html.lastIndexOf("<table", start);
    const tableEnd = html.indexOf("</table>", tableStart);
    if (tableStart < 0 || tableEnd < 0) break;
    tables.push(html.slice(tableStart, tableEnd + "</table>".length));
    idx = tableEnd + 1;
  }
  for (const t of tables) {
    const header = t.slice(0, 3000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // Header cells sometimes split "GICS Sector" across adjacent <th>
    // (Wikipedia rowspan quirk). Loose match: Symbol + GICS present.
    if (/\bSymbol\b/i.test(header) && /GICS/i.test(header) && /Sector|Sub-Industry/i.test(header)) return t;
  }
  throw new Error(`no wikitable with Symbol + GICS Sector columns found (${tables.length} tables total)`);
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTable(tableHtml) {
  const rows = [];
  const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  if (rowMatches.length === 0) throw new Error("no <tr> in constituents table");
  // Determine column order from the header.
  const headerCells = (rowMatches[0].match(/<t[dh][\s\S]*?<\/t[dh]>/g) ?? []).map(stripTags);
  const symbolIdx = headerCells.findIndex((h) => /^symbol$/i.test(h));
  const companyIdx = headerCells.findIndex((h) => /^company$|^security$/i.test(h));
  const sectorIdx = headerCells.findIndex((h) => /^gics sector$/i.test(h));
  const subIndustryIdx = headerCells.findIndex((h) => /^gics sub-industry$|^gics sub industry$/i.test(h));
  if (symbolIdx < 0 || companyIdx < 0 || sectorIdx < 0) {
    throw new Error(`header column detection failed: cols=[${headerCells.join(" | ")}]`);
  }
  for (const row of rowMatches.slice(1)) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) ?? []).map(stripTags);
    if (cells.length < 3) continue;
    const symbol = cells[symbolIdx];
    const name = cells[companyIdx];
    const gicsSector = cells[sectorIdx];
    const gicsSubIndustry = subIndustryIdx >= 0 ? cells[subIndustryIdx] : "";
    if (!symbol || !/^[A-Z]/.test(symbol)) continue;
    rows.push({
      symbol,
      name,
      gics_sector: gicsSector,
      gics_sub_industry: gicsSubIndustry,
      cik: null, // resolved later via scripts/resolve-missing-ciks.mjs
      date_added: null,
    });
  }
  return rows;
}

function normalizeSymbol(s) { return s.replace(/[.\-\/]/g, "").toUpperCase(); }

async function main() {
  const html = await fs.readFile(HTML_PATH, "utf-8");
  const table = extractConstituentsTable(html);
  const rows = parseTable(table);
  console.log(`parsed ${rows.length} constituents from Russell 1000 wikitable`);
  if (rows.length < 800 || rows.length > 1200) {
    console.error(`::error::row count ${rows.length} outside expected 800-1200 — parse likely broke, ABORTING`);
    process.exit(1);
  }

  const reference = {
    schema: "russell1000-reference/v1",
    as_of: new Date().toISOString().slice(0, 10),
    source: {
      name: "Wikipedia — Russell 1000 Index",
      url: "https://en.wikipedia.org/wiki/Russell_1000_Index",
      fetched_at: new Date().toISOString(),
      note: "Constituents table on the Russell 1000 wiki page. CIK column absent — CIKs auto-resolved via scripts/resolve-missing-ciks.mjs after registration.",
    },
    constituents: rows,
  };

  if (!DRY) {
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify(reference, null, 2));
    console.log(`✓ wrote ${path.relative(ROOT, OUT_PATH)}`);
  }

  // Reconcile against registry (same shape as sp500-reconcile).
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  const byTicker = new Map(entities.map((e) => [e.ticker, e]));
  const byNormalizedSymbolUs = new Map();
  for (const e of entities) {
    if (!e.ticker.endsWith(" US")) continue;
    const root = e.ticker.split(/\s+/)[0];
    byNormalizedSymbolUs.set(normalizeSymbol(root), e);
  }
  let matched = 0, missing = 0;
  const missingSectors = new Map();
  const alreadySP500 = [];
  const notSP500 = [];
  for (const c of rows) {
    const bloomberg = `${c.symbol.replace(/\./g, "/")} US`;
    let hit = byTicker.get(bloomberg) ?? byNormalizedSymbolUs.get(normalizeSymbol(c.symbol));
    if (hit) {
      matched++;
      if ((hit.index_membership ?? []).includes("SP500")) alreadySP500.push(c.symbol);
      else notSP500.push(c.symbol);
    } else {
      missing++;
      missingSectors.set(c.gics_sector, (missingSectors.get(c.gics_sector) ?? 0) + 1);
    }
  }
  console.log(`\n=== Russell 1000 reconciliation vs registry ===`);
  console.log(`  total constituents:  ${rows.length}`);
  console.log(`  matched:             ${matched}`);
  console.log(`    · overlaps w/SP500: ${alreadySP500.length}`);
  console.log(`    · non-SP500 in reg: ${notSP500.length}`);
  console.log(`  missing:             ${missing}`);
  console.log(`\n  missing by GICS sector:`);
  for (const [s, n] of [...missingSectors].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(28)} ${n}`);
  }
}

main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
