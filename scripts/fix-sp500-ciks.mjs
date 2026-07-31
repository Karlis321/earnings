#!/usr/bin/env node
/**
 * Reconcile SP500 members' edgarCik against Wikipedia's constituents
 * table. When they differ, prefer Wikipedia's (SP500 constituents are
 * US-primary and Wikipedia keeps this field authoritative). Fixes
 * cases where the registry had a stale/wrong CIK from an earlier
 * mis-ingest (XOM US had 0002115436 vs the correct 0000034088).
 *
 * ONLY updates US-primary listings ("<SYMBOL> US"). Foreign
 * listings sharing a companyId can have different CIK stamps that
 * shouldn't get overwritten.
 *
 *   node scripts/fix-sp500-ciks.mjs           # write
 *   node scripts/fix-sp500-ciks.mjs --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const SP500_PATH = path.join(ROOT, "data", "reference", "sp500.json");

const DRY = process.argv.includes("--dry-run");

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const ref = JSON.parse(await fs.readFile(SP500_PATH, "utf-8"));

  // Wikipedia symbol → CIK map.
  const wikiCik = new Map();
  for (const c of ref.constituents ?? []) {
    if (c.cik) wikiCik.set(c.symbol.replace(/\./g, "/"), c.cik);
  }

  let updated = 0;
  const changes = [];
  const entities = (reg.entities ?? []).map((e) => {
    if (!(e.index_membership ?? []).includes("SP500")) return e;
    if (!e.ticker.endsWith(" US")) return e;
    const root = e.ticker.split(/\s+/)[0];
    const wikiCikForRoot = wikiCik.get(root);
    if (!wikiCikForRoot) return e;
    if (e.edgarCik === wikiCikForRoot) return e;
    changes.push({ ticker: e.ticker, old: e.edgarCik, new: wikiCikForRoot });
    updated++;
    return { ...e, edgarCik: wikiCikForRoot };
  });

  console.log(`=== fix-sp500-ciks ===`);
  console.log(`  SP500 members scanned:  ${wikiCik.size}`);
  console.log(`  CIK updates:            ${updated}`);
  for (const c of changes.slice(0, 25)) {
    console.log(`    ${c.ticker.padEnd(14)} ${c.old ?? "null"} → ${c.new}`);
  }
  if (changes.length > 25) console.log(`    …+${changes.length - 25} more`);

  if (!DRY && updated > 0) {
    await fs.writeFile(REG_PATH, JSON.stringify({ ...reg, entities }, null, 2));
    console.log(`  ✓ wrote registry`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
