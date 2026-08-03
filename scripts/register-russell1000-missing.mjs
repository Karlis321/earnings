#!/usr/bin/env node
/**
 * Register the ~498 Russell 1000 constituents missing from the
 * entity-registry, and flag every matched + new R1000 member with
 * index_membership: [..., "R1000"]. Mirrors register-sp500-missing
 * .mjs — same GICS-sector-tag mapping, same shape.
 *
 * Difference from SP500: no CIK column in the Wikipedia table.
 * Entities go in with edgarCik === undefined; the daily orchestrator's
 * resolve-missing-ciks phase auto-fills it via SEC's ticker→CIK JSON.
 *
 *   node scripts/register-russell1000-missing.mjs
 *   node scripts/register-russell1000-missing.mjs --dry-run
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const REF_PATH = path.join(ROOT, "data", "reference", "russell1000.json");

const DRY = process.argv.includes("--dry-run");

const GICS_SECTOR_TAGS = {
  "Communication Services": ["communication-services"],
  "Consumer Discretionary": ["consumer-cyclical"],
  "Consumer Staples": ["consumer-defensive"],
  "Energy": ["energy", "oil-gas"],
  "Financials": ["financials", "financial-services"],
  "Health Care": ["healthcare"],
  "Industrials": ["industrials"],
  "Information Technology": ["technology"],
  "Materials": ["materials"],
  "Real Estate": ["real-estate"],
  "Utilities": ["utilities"],
};

function normalizeSymbol(s) { return s.replace(/[.\-\/]/g, "").toUpperCase(); }
function bloombergTicker(wiki) { return `${wiki.replace(/\./g, "/")} US`; }
function yahooSymbol(wiki) { return wiki.replace(/\./g, "-"); }
function cashtag(wiki) { return wiki.replace(/[.\-]/g, ""); }
function companyId(seed) {
  return "co-" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
}

function buildEntity(wiki) {
  const ticker = bloombergTicker(wiki.symbol);
  const sectorTags = GICS_SECTOR_TAGS[wiki.gics_sector] ?? [
    wiki.gics_sector.toLowerCase().replace(/\s+/g, "-"),
  ];
  return {
    ticker,
    legalName: wiki.name,
    displayName: wiki.name,
    aliases: [wiki.name, wiki.symbol],
    exclusionAliases: [],
    sectorTags,
    cashtag: cashtag(wiki.symbol),
    isCore: false,
    securityType: "operating",
    coverage: "shallow",
    listing: "US",
    currency: "USD",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
    yahooSymbol: yahooSymbol(wiki.symbol),
    // edgarCik intentionally undefined — resolve-missing-ciks.mjs
    // will fill it on the next daily refresh.
    industryGroup: wiki.gics_sub_industry || null,
    industryGroupSource: "direct",
    companyId: companyId("r1000-" + wiki.symbol),
    isCanonical: true,
    index_membership: ["R1000"],
  };
}

async function main() {
  const ref = JSON.parse(await fs.readFile(REF_PATH, "utf-8"));
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];

  const byTicker = new Map(entities.map((e) => [e.ticker, e]));
  const byNormalizedSymbolUs = new Map();
  for (const e of entities) {
    if (!e.ticker.endsWith(" US")) continue;
    const root = e.ticker.split(/\s+/)[0];
    byNormalizedSymbolUs.set(normalizeSymbol(root), e);
  }

  let flaggedExisting = 0;
  let added = 0;
  const newlyAdded = [];
  const updated = entities.map((e) => ({ ...e }));
  const tickerToIndex = new Map(updated.map((e, i) => [e.ticker, i]));

  for (const c of ref.constituents) {
    const bloomberg = bloombergTicker(c.symbol);
    let hit = byTicker.get(bloomberg) ?? byNormalizedSymbolUs.get(normalizeSymbol(c.symbol));

    if (hit) {
      const idx = tickerToIndex.get(hit.ticker);
      if (idx == null) continue;
      const existing = updated[idx];
      const mem = new Set(existing.index_membership ?? []);
      if (!mem.has("R1000")) {
        mem.add("R1000");
        updated[idx] = { ...existing, index_membership: [...mem] };
        flaggedExisting++;
      }
    } else {
      const newEntity = buildEntity(c);
      updated.push(newEntity);
      newlyAdded.push(newEntity.ticker);
      added++;
    }
  }

  console.log(`=== register-russell1000-missing ===`);
  console.log(`  constituents:                              ${ref.constituents.length}`);
  console.log(`  flagged existing (R1000 flag added):       ${flaggedExisting}`);
  console.log(`  new entities registered:                   ${added}`);
  console.log(`  registry entities before → after:          ${entities.length} → ${updated.length}`);
  const r1000Count = updated.filter((e) => (e.index_membership ?? []).includes("R1000")).length;
  console.log(`  entities carrying R1000 flag:              ${r1000Count}`);
  console.log(`\n  sample newly-added (first 15):`);
  for (const t of newlyAdded.slice(0, 15)) console.log(`    ${t}`);
  if (newlyAdded.length > 15) console.log(`    …+${newlyAdded.length - 15} more`);

  if (!DRY) {
    await fs.writeFile(REG_PATH, JSON.stringify({ ...reg, entities: updated }, null, 2));
    console.log(`\n  ✓ wrote registry`);
  }
}

main().catch((e) => { console.error(`::error::${e.stack ?? e.message}`); process.exit(1); });
