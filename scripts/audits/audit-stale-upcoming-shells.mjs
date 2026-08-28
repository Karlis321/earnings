#!/usr/bin/env node
/**
 * Audit: for every US-CIK entity whose "next" event is an estimator
 * projection within ±14 days of today, ask SEC EDGAR whether a
 * 10-Q / 10-K has ALREADY landed with a reportDate more recent than
 * the shard's `lastEventDate`. Prints a flagged list — READ ONLY,
 * writes only an audit JSON.
 *
 * Motivating example: NVDA US had `nextScheduled=2026-08-29`
 * (estimator) on 2026-08-28 but SEC shows a 10-Q filed 2026-08-26
 * for reportDate 2026-07-26 — Q2 already reported, shard stale.
 *
 *   node scripts/audits/audit-stale-upcoming-shells.mjs
 *
 * Writes scripts/audits/stale-upcoming-shells.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const IDX_PATH = path.join(ROOT, "data", "events-index.json");
const AUDIT = path.join(ROOT, "scripts", "audits", "stale-upcoming-shells.json");

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
    headers: {
      "User-Agent": UA,
      "Accept-Encoding": "gzip",
      Accept: "application/json",
    },
  });
}

function padCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const idx = JSON.parse(await fs.readFile(IDX_PATH, "utf-8"));
  const entByTicker = new Map((reg.entities ?? []).map((e) => [e.ticker, e]));

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const WINDOW_DAYS = 14;

  // Collect candidates: US-CIK entities with estimator-projected
  // next event within ±14 days of today.
  const candidates = [];
  for (const entry of idx.entries ?? []) {
    if (!entry.nextScheduled) continue;
    if (!entry.nextIsEstimated) continue;
    const ent = entByTicker.get(entry.ticker);
    if (!ent?.edgarCik) continue;
    if (ent.secFilerType === "foreign" || ent.secFilerType === "pre-listing") continue;
    if (!entry.ticker.endsWith(" US")) continue;
    const days =
      (new Date(entry.nextScheduled + "T00:00:00Z").getTime() - today.getTime()) /
      86_400_000;
    if (Math.abs(days) > WINDOW_DAYS) continue;
    candidates.push({
      ticker: entry.ticker,
      cik: ent.edgarCik,
      displayName: ent.displayName ?? entry.ticker,
      lastEventDate: entry.lastEventDate ?? null,
      nextScheduled: entry.nextScheduled,
      nextPeriod: entry.nextPeriod,
      daysUntilNext: Math.round(days),
    });
  }
  console.log(`Candidates (US CIK + estimator + ±${WINDOW_DAYS}d): ${candidates.length}`);

  // Group by CIK to dedupe cross-listings (only one fetch per CIK).
  const byCik = new Map();
  for (const c of candidates) {
    if (!byCik.has(c.cik)) byCik.set(c.cik, []);
    byCik.get(c.cik).push(c);
  }
  console.log(`Unique CIKs to query: ${byCik.size}`);

  const audit = {
    schema: "stale-upcoming-shells/v1",
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    totals: {
      candidates: candidates.length,
      ciks_fetched: 0,
      fetch_errors: 0,
      stale_shells: 0,
      confirmed_upcoming: 0,
    },
    stale: [],
    confirmedUpcoming: [],
    fetchErrors: [],
  };

  const ciks = [...byCik.keys()];
  for (let i = 0; i < ciks.length; i++) {
    const cik = ciks[i];
    const list = byCik.get(cik);
    const preview = list[0].ticker;
    process.stdout.write(`  [${i + 1}/${ciks.length}] CIK ${cik} · ${preview}`);
    let submissions;
    try {
      const res = await throttledFetch(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      submissions = await res.json();
    } catch (e) {
      console.log(` · ERROR: ${e.message}`);
      audit.totals.fetch_errors++;
      audit.fetchErrors.push({ cik, ticker: preview, error: e.message });
      continue;
    }
    audit.totals.ciks_fetched++;

    const r = submissions.filings?.recent ?? {};
    const forms = r.form ?? [];
    // Find the most recent 10-Q / 10-K in the recent block.
    let mostRecentReport = null;
    for (let j = 0; j < forms.length; j++) {
      if (["10-Q", "10-K", "10-Q/A", "10-K/A"].includes(forms[j])) {
        const filed = r.filingDate[j];
        const report = r.reportDate[j];
        const primary = r.primaryDocument[j];
        const acc = r.accessionNumber[j];
        if (!mostRecentReport || filed > mostRecentReport.filed) {
          mostRecentReport = { form: forms[j], filed, report, primary, acc };
        }
      }
    }

    for (const c of list) {
      if (!mostRecentReport) {
        audit.confirmedUpcoming.push({ ...c, note: "no 10-Q/10-K in recent block" });
        audit.totals.confirmed_upcoming++;
        continue;
      }
      // Rule: if the most-recent 10-Q/10-K reportDate is AFTER the
      // shard's lastEventDate, the shell we're calling "upcoming" is
      // in reality already reported.
      const shardLastKnown = c.lastEventDate ?? "0000-00-00";
      if (mostRecentReport.report > shardLastKnown) {
        audit.stale.push({
          ...c,
          latestFiling: {
            form: mostRecentReport.form,
            filed: mostRecentReport.filed,
            report: mostRecentReport.report,
            url: `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/\D/g, "").replace(/^0+/, "") || "0"}/${mostRecentReport.acc.replace(/-/g, "")}/${mostRecentReport.primary}`,
          },
        });
        audit.totals.stale_shells++;
      } else {
        audit.confirmedUpcoming.push({
          ...c,
          latestFiledReportDate: mostRecentReport.report,
        });
        audit.totals.confirmed_upcoming++;
      }
    }
    console.log(
      ` · ${mostRecentReport ? mostRecentReport.form + " report=" + mostRecentReport.report : "no periodic"}`,
    );
  }

  await fs.writeFile(AUDIT, JSON.stringify(audit, null, 2));

  console.log(`\n=== done ===`);
  console.log(`  candidates:         ${audit.totals.candidates}`);
  console.log(`  CIKs fetched:       ${audit.totals.ciks_fetched}`);
  console.log(`  fetch errors:       ${audit.totals.fetch_errors}`);
  console.log(`  STALE shells:       ${audit.totals.stale_shells}`);
  console.log(`  confirmed upcoming: ${audit.totals.confirmed_upcoming}`);
  console.log(`  audit → ${path.relative(ROOT, AUDIT)}`);

  if (audit.stale.length > 0) {
    console.log(`\n=== stale shells (need promotion) ===`);
    for (const s of audit.stale) {
      console.log(
        `  ${s.ticker.padEnd(12)} · shard last=${s.lastEventDate} · SEC ${s.latestFiling.form} report=${s.latestFiling.report} · shell projected=${s.nextScheduled}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
