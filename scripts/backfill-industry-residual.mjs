#!/usr/bin/env node
/**
 * TODO Item 6 — Residual industry-group backfill.
 *
 * The main `backfill-industry-groups.mjs` uses Yahoo v10 assetProfile
 * and covers 92% of the registry. The residual 151 unclassified are:
 *   - 125 ETFs (Yahoo returns no `industry` for funds — expected)
 *   - 26 foreign operating symbols where assetProfile was empty
 *
 * We *could* try SEC XBRL SIC on the residual, but 0/151 have an
 * edgarCik so that path is closed. Alternative fills:
 *
 *   - ETFs → `industryGroup: "ETF"` (industry is orthogonal to a fund
 *     product; today they read as "unclassified" in sector panels,
 *     which is misleading).
 *   - Foreign operating → coarse sector-tag fallback (e.g.
 *     "Technology (unclassified)"). Marked as `(unclassified)` so a
 *     later cron pass that finds a Yahoo industry still supersedes it.
 *
 * Sets `industryGroupSource: "residual-fallback"` on any entity it
 * touches so the next Yahoo pass can distinguish real assetProfile
 * hits from these coarse fallbacks and overwrite them.
 *
 *   node scripts/backfill-industry-residual.mjs [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");

const SECTOR_TAG_TO_GROUP = {
  technology: "Technology (unclassified)",
  healthcare: "Healthcare (unclassified)",
  industrials: "Industrials (unclassified)",
  energy: "Energy (unclassified)",
  financials: "Financials (unclassified)",
  "financial-services": "Financials (unclassified)",
  "consumer-cyclical": "Consumer Cyclical (unclassified)",
  "consumer-defensive": "Consumer Defensive (unclassified)",
  "communication-services": "Communication Services (unclassified)",
  utilities: "Utilities (unclassified)",
  "real-estate": "Real Estate (unclassified)",
  "basic-materials": "Basic Materials (unclassified)",
};

async function main() {
  console.log(`backfill-industry-residual · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const asOf = new Date().toISOString();
  const changes = [];
  let etfCount = 0;
  let sectorCount = 0;
  let stillNone = 0;

  for (const e of reg.entities || []) {
    if (e.industryGroup) continue;
    if (e.securityType === "etf") {
      e.industryGroup = "ETF";
      e.industryGroupSource = "residual-fallback";
      e.industryGroupAsOf = asOf;
      etfCount++;
      changes.push({ ticker: e.ticker, to: "ETF", reason: "securityType=etf" });
      continue;
    }
    const tag = (e.sectorTags || [])[0];
    const group = tag ? SECTOR_TAG_TO_GROUP[tag] : null;
    if (group) {
      e.industryGroup = group;
      e.industryGroupSource = "residual-fallback";
      e.industryGroupAsOf = asOf;
      sectorCount++;
      changes.push({ ticker: e.ticker, to: group, reason: `sectorTag=${tag}` });
    } else {
      stillNone++;
    }
  }

  console.log(`ETF backfilled:               ${etfCount}`);
  console.log(`Sector-tag fallback:          ${sectorCount}`);
  console.log(`Still unclassified:           ${stillNone}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const auditPath = path.join(OUT_DIR, "industry-residual.json");
  await fs.writeFile(
    auditPath,
    JSON.stringify(
      {
        schema: "industry-residual/v1",
        generatedAt: asOf,
        etfBackfilled: etfCount,
        sectorFallback: sectorCount,
        stillUnclassified: stillNone,
        changes,
      },
      null,
      2,
    ),
  );
  console.log(`✓ audit → ${auditPath}`);

  if (DRY) {
    console.log("[dry-run] registry NOT written");
    return;
  }
  await fs.writeFile(REG_PATH, JSON.stringify(reg, null, 2) + "\n");
  console.log(`✓ registry updated`);
}

main().catch((e) => { console.error(e); process.exit(1); });
