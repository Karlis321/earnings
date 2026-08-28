#!/usr/bin/env node
/**
 * For each CIK whose events remained unmatched after
 * backfill-solvable-source-links.mjs, fetch SEC submissions and
 * enumerate the forms actually filed. If NO 10-Q/10-K/10-Q-A/10-K-A
 * exists in the recent window, the entity is treated as a foreign
 * filer (`secFilerType="foreign"`) — this routes the events to the
 * structural bucket in pipeline-report, matching reality (they file
 * 20-F/40-F annually instead of quarterly with SEC).
 *
 *   node scripts/backfills/classify-unmatched-filers.mjs --dry
 *   node scripts/backfills/classify-unmatched-filers.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const AUDIT_IN = path.join(ROOT, "scripts", "audits", "backfill-solvable-source-links.json");
const AUDIT_OUT = path.join(ROOT, "scripts", "audits", "classify-unmatched-filers.json");

const DRY = process.argv.includes("--dry");
const EMAIL = process.env.EDGAR_CONTACT_EMAIL || "your-email@example.com";
const UA = `earnings dashboard ${EMAIL}`;
const MIN_SPACING_MS = 1100;

let lastFetchAt = 0;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function throttledFetch(url) {
  const wait = lastFetchAt + MIN_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();
  return await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Encoding": "gzip", Accept: "application/json" },
  });
}

function padCik(cik) { return String(cik).replace(/\D/g, "").padStart(10, "0"); }

async function main() {
  const backfillAudit = JSON.parse(await fs.readFile(AUDIT_IN, "utf-8"));
  const unmatched = backfillAudit.unmatched ?? [];
  const cikToTickers = new Map();
  for (const u of unmatched) {
    if (!cikToTickers.has(u.cik)) cikToTickers.set(u.cik, new Set());
    cikToTickers.get(u.cik).add(u.ticker);
  }
  console.log(`Inspecting ${cikToTickers.size} CIKs with unmatched events...`);

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  const audit = {
    schema: "classify-unmatched-filers/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    perCik: [],
    totals: { ciks_inspected: 0, foreign_classified: 0, tickers_updated: 0, kept_as_is: 0 },
  };

  const flipTickers = new Set();
  for (const [cik, tickerSet] of cikToTickers) {
    audit.totals.ciks_inspected++;
    const tickers = [...tickerSet];
    process.stdout.write(`  CIK ${cik} · ${tickers.join(", ")}`);
    let submissions;
    try {
      const res = await throttledFetch(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      submissions = await res.json();
    } catch (e) {
      console.log(` · fetch ERROR: ${e.message}`);
      audit.perCik.push({ cik, tickers, error: e.message });
      continue;
    }
    const r = submissions.filings?.recent ?? {};
    const forms = r.form ?? [];
    const formCounts = {};
    for (const f of forms) formCounts[f] = (formCounts[f] ?? 0) + 1;
    const hasQuarterly = ["10-Q", "10-K", "10-Q/A", "10-K/A"].some((f) => (formCounts[f] ?? 0) > 0);
    const hasAnnualForeign = ["20-F", "40-F", "20-F/A", "40-F/A", "6-K"].some((f) => (formCounts[f] ?? 0) > 0);
    // F-6 / F-6 POS / F-6EF are depositary-receipt registrations
    // filed by the DR bank; the underlying business is foreign and
    // doesn't file business financials with SEC.
    const onlyDepositaryFilings =
      !hasQuarterly &&
      !hasAnnualForeign &&
      forms.length > 0 &&
      forms.every((f) => f.startsWith("F-6"));
    let classification;
    if (!hasQuarterly && hasAnnualForeign) classification = "foreign";
    else if (onlyDepositaryFilings) classification = "foreign";
    else if (!hasQuarterly) classification = "unknown-no-periodics";
    else classification = "kept-as-is";
    console.log(` · forms=${Object.keys(formCounts).slice(0,6).join(",")} · ${classification}`);
    audit.perCik.push({ cik, tickers, formCounts, classification });
    if (classification === "foreign") {
      audit.totals.foreign_classified++;
      for (const t of tickers) flipTickers.add(t);
    } else {
      audit.totals.kept_as_is++;
    }
  }

  // Apply secFilerType="foreign" to the identified tickers AND to
  // every sibling ticker sharing the same CIK (so cross-listing
  // consistency stays intact).
  if (!DRY && flipTickers.size > 0) {
    const flipCiks = new Set();
    for (const t of flipTickers) {
      const ent = entities.find((e) => e.ticker === t);
      if (ent?.edgarCik) flipCiks.add(ent.edgarCik);
    }
    let updated = 0;
    for (const e of entities) {
      if (e.edgarCik && flipCiks.has(e.edgarCik)) {
        if (e.secFilerType !== "foreign") {
          e.secFilerType = "foreign";
          updated++;
        }
      }
    }
    audit.totals.tickers_updated = updated;
    await fs.writeFile(REG_PATH, JSON.stringify(reg, null, 2));
    console.log(`\nUpdated ${updated} entities to secFilerType="foreign".`);
  } else {
    console.log(`\n(dry run — would flip ${flipTickers.size} tickers)`);
  }

  await fs.writeFile(AUDIT_OUT, JSON.stringify(audit, null, 2));
  console.log(`\n=== done ===`);
  console.log(`  CIKs inspected:      ${audit.totals.ciks_inspected}`);
  console.log(`  classified foreign:  ${audit.totals.foreign_classified}`);
  console.log(`  tickers updated:     ${audit.totals.tickers_updated}`);
  console.log(`  audit →              ${path.relative(ROOT, AUDIT_OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
