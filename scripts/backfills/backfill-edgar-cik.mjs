#!/usr/bin/env node
/**
 * Mirror cron step 6c: resolve every entity's EDGAR CIK from SEC's
 * public ticker->CIK JSON, write back into data/entity-registry.json.
 *
 * Matching:
 *   1. base symbol (before space) exact
 *   2. `<symbol>F` variant (foreign private issuers on OTC)
 *   3. normalized legal-name fallback (strips corp/inc/ltd/etc.)
 *
 * Verified null (searched and not found) is stored as null so cron
 * doesn't retry every day.
 *
 *   node scripts/backfill-edgar-cik.mjs         # write
 *   node scripts/backfill-edgar-cik.mjs --dry   # report only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;

const SEC_UA = "Earnings Tracker (contact@example.com)";
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

function pad10(cik) {
  return String(cik).padStart(10, "0");
}
function normalizeName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(
      /\b(?:corporation|corp|incorporated|inc|company|co|limited|ltd|plc|s\.?a\.?|nv|ag|se|holdings?|group)\b/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function loadSecMap() {
  const r = await fetch(SEC_TICKERS_URL, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`sec company_tickers ${r.status}`);
  const raw = await r.json();
  const byTicker = new Map();
  const byNormalizedTitle = new Map();
  for (const row of Object.values(raw)) {
    byTicker.set(row.ticker.toUpperCase(), row);
    byNormalizedTitle.set(normalizeName(row.title), row);
  }
  return { byTicker, byNormalizedTitle };
}

function resolve(entity, secMap) {
  const [rawSym, exch = "US"] = entity.ticker.split(/\s+/);
  const sym = rawSym.toUpperCase();
  const isUs = exch.toUpperCase() === "US";
  const normalizedInput = normalizeName(entity.legalName ?? "");
  if (isUs) {
    const direct = secMap.byTicker.get(sym);
    if (direct) return pad10(direct.cik_str);
  } else {
    // Non-US: base-symbol match is unsafe (e.g. RIO FP is Amundi
    // Brazil, not Rio Tinto). Require legal-name overlap.
    const direct = secMap.byTicker.get(sym);
    if (direct && normalizedInput) {
      const secNorm = normalizeName(direct.title);
      if (
        secNorm &&
        (secNorm === normalizedInput ||
          secNorm.includes(normalizedInput) ||
          normalizedInput.includes(secNorm))
      ) {
        return pad10(direct.cik_str);
      }
    }
    const fVariant = secMap.byTicker.get(sym + "F");
    if (fVariant) return pad10(fVariant.cik_str);
  }
  if (normalizedInput) {
    const hit = secMap.byNormalizedTitle.get(normalizedInput);
    if (hit) return pad10(hit.cik_str);
  }
  return null;
}

async function main() {
  console.log(`backfill-edgar-cik · dry=${DRY}`);
  const raw = await fs.readFile(REGISTRY_PATH, "utf-8");
  const registry = JSON.parse(raw);

  const secMap = await loadSecMap();
  console.log(`Loaded SEC ticker map: ${secMap.byTicker.size} tickers`);

  let resolved = 0;
  let alreadySet = 0;
  let stillNull = 0;
  const hits = [];

  for (const entity of registry.entities) {
    if (entity.edgarCik !== undefined) {
      alreadySet++;
      continue;
    }
    const cik = resolve(entity, secMap);
    entity.edgarCik = cik;
    if (cik) {
      resolved++;
      hits.push(`${entity.ticker.padEnd(14)} → ${cik}  (${entity.legalName ?? entity.displayName})`);
    } else {
      stillNull++;
    }
  }

  console.log(`\nHits (first 20):`);
  for (const h of hits.slice(0, 20)) console.log(`  ${h}`);
  if (hits.length > 20) console.log(`  … +${hits.length - 20} more`);
  console.log(`\nResolved to CIK: ${resolved} · non-filers (null): ${stillNull} · already set: ${alreadySet}`);

  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`\n✓ wrote ${REGISTRY_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
