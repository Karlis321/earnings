#!/usr/bin/env node
/**
 * Reads scripts/audits/triage-report-attachment.json and applies
 * `secFilerType` on each classified entity so the pipelineReport
 * counter routes them into the structural bucket:
 *
 *   • `foreign-primary-adr` → secFilerType: "foreign"
 *       CIK only files 6-K / 20-F / 40-F, no 10-Q / 10-K. Document
 *       rule follows the home venue (irSources).
 *
 *   • `pre-listing-tail` → secFilerType: "pre-listing"
 *       CIK IS a valid 10-Q filer, but every violating event
 *       predates the CIK's earliest SEC filing. Yahoo imported
 *       pre-IPO quarters that will never have a SEC filing under
 *       this CIK. (MDLN, LLYVK/LLYVA, VNOM, PNFP-new, etc.)
 *
 *   node scripts/apply-sec-filer-type.mjs           # write
 *   node scripts/apply-sec-filer-type.mjs --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const AUDIT_PATH = path.join(ROOT, "scripts", "audits", "triage-report-attachment.json");

const DRY = process.argv.includes("--dry-run");

async function main() {
  const audit = JSON.parse(await fs.readFile(AUDIT_PATH, "utf-8"));
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const foreignTickers = new Set(
    (audit.results ?? [])
      .filter((r) => r.class === "foreign-primary-adr")
      .map((r) => r.ticker),
  );
  const preListingTickers = new Set(
    (audit.results ?? [])
      .filter((r) => r.class === "pre-listing-tail")
      .map((r) => r.ticker),
  );
  let flagged = 0;
  const entities = (reg.entities ?? []).map((e) => {
    if (foreignTickers.has(e.ticker) && e.secFilerType !== "foreign") {
      flagged++;
      return { ...e, secFilerType: "foreign" };
    }
    if (preListingTickers.has(e.ticker) && e.secFilerType !== "pre-listing") {
      flagged++;
      return { ...e, secFilerType: "pre-listing" };
    }
    return e;
  });
  console.log(`=== apply-sec-filer-type ===`);
  console.log(`  foreign-primary tickers in triage:  ${foreignTickers.size}`);
  console.log(`  pre-listing tickers in triage:      ${preListingTickers.size}`);
  console.log(`  entities newly flagged:             ${flagged}`);
  for (const t of foreignTickers) console.log(`    foreign     · ${t}`);
  for (const t of preListingTickers) console.log(`    pre-listing · ${t}`);
  if (!DRY && flagged > 0) {
    await fs.writeFile(REG_PATH, JSON.stringify({ ...reg, entities }, null, 2));
    console.log(`  ✓ wrote registry`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
