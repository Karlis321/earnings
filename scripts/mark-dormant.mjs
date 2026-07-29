#!/usr/bin/env node
/**
 * TODO Item 5 — Mark long-quiet 1-print entities as dormant.
 *
 * `run-estimator.mjs` couldn't project a next event for 46 tickers
 * because each has only one past event (no cadence to infer). Split:
 *
 *   - 32 stale (last print > 6 months ago) → mark `dormant: true`
 *     so the UI can render them as "no scheduled catalyst — dormant"
 *     rather than "unscheduled" (which implies temporarily).
 *   - 14 recent (last print ≤ 6 months) → leave as unscheduled; may
 *     be first prints from a newly-added semi/annual filer.
 *
 * ENEFI HB is 174 months (~14 years) stale — that's a delisted-in-
 * everything-but-name case and we should have caught it earlier.
 *
 *   node scripts/mark-dormant.mjs [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const IDX_PATH = path.join(ROOT, "data", "events-index.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const TODAY = new Date();
const STALE_MONTHS = 6;

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const idxRaw = JSON.parse(await fs.readFile(IDX_PATH, "utf-8"));
  const items = Array.isArray(idxRaw) ? idxRaw : idxRaw.entries ?? idxRaw.items ?? [];

  const dormantTickers = new Set();
  const recentTickers = new Set();
  for (const it of items) {
    if ((it.count ?? 0) === 0) continue;
    if (it.nextScheduled && it.nextEventId) continue;
    const d = new Date(it.lastEventDate);
    const monthsAgo = (TODAY - d) / 1000 / 60 / 60 / 24 / 30.44;
    if (monthsAgo > STALE_MONTHS) dormantTickers.add(it.ticker);
    else recentTickers.add(it.ticker);
  }

  const asOf = new Date().toISOString();
  const touched = [];
  let alreadyDormant = 0;
  for (const e of reg.entities || []) {
    if (dormantTickers.has(e.ticker)) {
      if (e.dormant === true) { alreadyDormant++; continue; }
      e.dormant = true;
      e.dormantAsOf = asOf;
      e.dormantReason = "single-print >6mo stale, cadence unknown";
      touched.push(e.ticker);
    }
  }

  console.log("=== mark-dormant ===");
  console.log(`Candidates (stale >6mo):     ${dormantTickers.size}`);
  console.log(`Already flagged:             ${alreadyDormant}`);
  console.log(`Newly flagged:               ${touched.length}`);
  console.log(`Recent 1-prints (kept live): ${recentTickers.size}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const auditPath = path.join(OUT_DIR, "dormant-triage.json");
  await fs.writeFile(
    auditPath,
    JSON.stringify(
      {
        schema: "dormant-triage/v1",
        generatedAt: asOf,
        threshold_months: STALE_MONTHS,
        newlyFlagged: touched,
        alreadyFlagged: alreadyDormant,
        recentSinglePrints: [...recentTickers],
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
  console.log("✓ registry updated");
}

main().catch((e) => { console.error(e); process.exit(1); });
