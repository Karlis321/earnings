#!/usr/bin/env node
/**
 * Phase 2 step 1 — register the 418 missing S&P 500 constituents as
 * canonical operating entities, and flag every matched + new member
 * with index_membership: ["SP500"].
 *
 * This ONLY writes registry rows + index_membership flags. It does
 * NOT run the ingest pipes (yahoo timeseries, SEC-verbatim, etc.) —
 * those are separate targeted runs after this commit lands.
 *
 * Design:
 *   - Read data/reference/sp500.json (Phase 1 output).
 *   - Read data/entity-registry.json.
 *   - For each Wikipedia constituent:
 *       * If matched (exact / normalized / cik) → set
 *         index_membership: ["SP500"] on the existing entity.
 *       * If missing → build a canonical operating entity with the
 *         minimum viable field set. CIK comes from Wikipedia; sector
 *         + industryGroup come from Wikipedia's GICS labels (Yahoo's
 *         daily cron will refresh industryGroup to its own taxonomy
 *         on the next run).
 *   - Write back.
 *
 *   node scripts/register-sp500-missing.mjs
 *   node scripts/register-sp500-missing.mjs --dry-run
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const SP500_PATH = path.join(ROOT, "data", "reference", "sp500.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");

// GICS sector → our sectorTags palette. If a sector maps to multiple
// existing tags, the primary/first is used. Missing GICS sectors get
// a lowercase-hyphenated slug of the GICS name.
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

function bloombergTicker(wikiSymbol) {
  // Class-share dots become slashes in Bloomberg form.
  // BRK.B → BRK/B US. AAPL → AAPL US.
  return `${wikiSymbol.replace(/\./g, "/")} US`;
}

function yahooSymbol(wikiSymbol) {
  // Yahoo uses hyphens for class shares: BRK.B → BRK-B.
  return wikiSymbol.replace(/\./g, "-");
}

function cashtag(wikiSymbol) {
  // Cashtags on X/Twitter don't take punctuation.
  return wikiSymbol.replace(/[.\-]/g, "");
}

function companyId(cik, symbol) {
  // Deterministic short id — 12-char hex prefixed with co- (matches
  // existing convention). Seed with CIK if we have it; else symbol.
  const seed = cik ?? `sp500-${symbol}`;
  const hash = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
  return `co-${hash}`;
}

function edgarCikListUrl(cik) {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-Q&dateb=&owner=include&count=40`;
}

function buildEntity(wiki) {
  const ticker = bloombergTicker(wiki.symbol);
  const cik = wiki.cik; // already 10-digit padded from Phase 1
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
    edgarCik: cik,
    // industryGroup — Wikipedia's GICS sub-industry as a placeholder.
    // Yahoo's assetProfile.industry refresh on the next cron overwrites
    // this with the taxonomy we use elsewhere in the registry.
    industryGroup: wiki.gics_sub_industry,
    industryGroupSource: "direct",
    // Company grouping — every entity carries a companyId. SP500 members
    // are US-primary singletons at register-time; if a member later gets
    // a foreign listing added, apply-entity-groups.mjs will merge.
    companyId: companyId(cik, wiki.symbol),
    isCanonical: true,
    // irSources derivation for CIK holders is 100% mechanical — see the
    // observed/derived tier in build-ir-sources.mjs. Populate here to
    // save a follow-up sweep.
    irSources: {
      publication_venue: "EDGAR",
      reports_page_url: edgarCikListUrl(cik),
      ir_url: null,
      press_release_url: null,
      rss_feeds: [],
      publication_pattern: "EDGAR CIK-list — SP500 registration",
      verified_at: new Date().toISOString(),
      source: "derived",
    },
    index_membership: ["SP500"],
  };
}

async function main() {
  const ref = JSON.parse(await fs.readFile(SP500_PATH, "utf-8"));
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];

  // Build lookup maps mirroring Phase 1's reconciliation.
  const byTicker = new Map(entities.map((e) => [e.ticker, e]));
  const byCik = new Map();
  for (const e of entities) if (e.edgarCik) byCik.set(e.edgarCik, e);
  const byNormalizedSymbolUs = new Map();
  for (const e of entities) {
    const rootPart = e.ticker.split(/\s+/)[0];
    if (!e.ticker.endsWith(" US")) continue;
    byNormalizedSymbolUs.set(normalizeSymbol(rootPart), e);
  }

  // Track state for the summary.
  let flaggedExisting = 0;
  let added = 0;
  const newlyAdded = [];

  const updated = entities.map((e) => ({ ...e })); // shallow-clone rows
  const tickerToIndex = new Map(updated.map((e, i) => [e.ticker, i]));

  for (const c of ref.constituents) {
    const variants = {
      exact: bloombergTicker(c.symbol),
      slashed: bloombergTicker(c.symbol),
    };
    // Match order (mirrors Phase 1): exact → normalized → CIK.
    let hit = byTicker.get(variants.exact);
    if (!hit) hit = byNormalizedSymbolUs.get(normalizeSymbol(c.symbol));
    if (!hit && c.cik) hit = byCik.get(c.cik);

    if (hit) {
      // Flag existing entity with SP500 membership (idempotent).
      const idx = tickerToIndex.get(hit.ticker);
      if (idx == null) continue;
      const existing = updated[idx];
      const mem = new Set(existing.index_membership ?? []);
      if (!mem.has("SP500")) {
        mem.add("SP500");
        updated[idx] = { ...existing, index_membership: [...mem] };
        flaggedExisting++;
      }
    } else {
      // Missing — build new entity.
      const newEntity = buildEntity(c);
      updated.push(newEntity);
      newlyAdded.push(newEntity.ticker);
      added++;
    }
  }

  console.log(`\n=== register-sp500-missing ===`);
  console.log(`  constituents in reference: ${ref.constituents.length}`);
  console.log(`  flagged existing (SP500 membership added): ${flaggedExisting}`);
  console.log(`  new entities registered:                    ${added}`);
  console.log(`  registry entities before → after:           ${entities.length} → ${updated.length}`);
  const newSp500 = updated.filter((e) => (e.index_membership ?? []).includes("SP500")).length;
  console.log(`  entities carrying index_membership=SP500:   ${newSp500}`);
  console.log(`\n  sample of newly-added tickers:`);
  for (const t of newlyAdded.slice(0, 15)) console.log(`    ${t}`);
  if (newlyAdded.length > 15) console.log(`    …+${newlyAdded.length - 15} more`);

  if (!DRY) {
    await fs.writeFile(REG_PATH, JSON.stringify({ ...reg, entities: updated }, null, 2));
    console.log(`\n  ✓ wrote ${path.relative(ROOT, REG_PATH)}`);
  } else {
    console.log(`\n  --dry-run: no writes`);
  }
}

main().catch((e) => {
  console.error(`::error::register-sp500-missing crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
