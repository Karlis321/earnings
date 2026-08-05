#!/usr/bin/env node
/**
 * Auto-resolve `edgarCik` for entities where the field is
 * `undefined` — the exact same behaviour /api/cron/daily used to
 * run inline via resolveEdgarCik(). Uses SEC's public ticker→CIK
 * JSON (data.sec.gov/files/company_tickers.json). Stamps `null`
 * on the entity when the ticker is confirmed NOT on SEC so we
 * don't re-hit the resolver on future runs.
 *
 * Only touches entities where `edgarCik === undefined`. Existing
 * `null` (confirmed not on SEC) and existing values are preserved.
 *
 *   node scripts/resolve-missing-ciks.mjs           # write
 *   node scripts/resolve-missing-ciks.mjs --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const AUDIT_PATH = path.join(ROOT, "scripts", "audits", "resolve-missing-ciks.json");
// SEC EDGAR fair-access — real contact email required.
const SEC_UA = `earnings-dashboard ${process.env.EDGAR_CONTACT_EMAIL || "klpp@bluorbank.lv"}`;

const DRY = process.argv.includes("--dry-run");

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  const targets = entities.filter((e) => e.edgarCik === undefined);
  console.log(`resolve-missing-ciks · ${targets.length} entities with undefined edgarCik`);
  if (targets.length === 0) {
    console.log("  nothing to resolve.");
    return;
  }

  // Fetch SEC's public ticker→CIK JSON once.
  const r = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    console.error(`::error::SEC ticker file returned HTTP ${r.status}`);
    process.exit(1);
  }
  const j = await r.json();
  // Format is {"0":{cik_str:320193, ticker:"AAPL", title:"..."}, "1":{...}}
  const symbolToCik = new Map();
  for (const row of Object.values(j)) {
    if (row?.ticker) symbolToCik.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, "0"));
  }
  console.log(`  SEC ticker table loaded: ${symbolToCik.size} symbols`);

  let resolved = 0;
  let confirmedAbsent = 0;
  const updates = [];
  const updatedEntities = entities.map((e) => {
    if (e.edgarCik !== undefined) return e;
    // Extract the ROOT symbol (BRK/B US → BRK-B; NVDA US → NVDA).
    // SEC uses hyphens for class shares.
    const rootPart = e.ticker.split(/\s+/)[0];
    const rootUpper = rootPart.replace(/\//g, "-").toUpperCase();
    const cik = symbolToCik.get(rootUpper);
    if (cik) {
      resolved++;
      updates.push({ ticker: e.ticker, cik });
      return { ...e, edgarCik: cik };
    }
    // Confirmed not on SEC — stamp null so we don't re-hit.
    confirmedAbsent++;
    return { ...e, edgarCik: null };
  });

  console.log(`\n=== resolve-missing-ciks ===`);
  console.log(`  resolved:          ${resolved}`);
  console.log(`  confirmed absent:  ${confirmedAbsent}`);
  for (const u of updates.slice(0, 15)) console.log(`    ${u.ticker.padEnd(14)} → ${u.cik}`);
  if (updates.length > 15) console.log(`    …+${updates.length - 15} more`);

  if (!DRY && (resolved > 0 || confirmedAbsent > 0)) {
    await fs.writeFile(REG_PATH, JSON.stringify({ ...reg, entities: updatedEntities }, null, 2));
    console.log(`  ✓ wrote registry`);
  }
  await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await fs.writeFile(AUDIT_PATH, JSON.stringify({
    schema: "resolve-missing-ciks/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    scanned: targets.length,
    resolved,
    confirmedAbsent,
    updates,
  }, null, 2));
  console.log(`  audit → ${path.relative(ROOT, AUDIT_PATH)}`);
}

main().catch((e) => { console.error(`::error::resolve-missing-ciks crash: ${e.stack ?? e.message}`); process.exit(1); });
