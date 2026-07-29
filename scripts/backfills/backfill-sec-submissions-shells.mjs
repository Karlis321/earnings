#!/usr/bin/env node
/**
 * DEPRECATED (shard-first): reads + writes data/earnings.json (gitignored).
 * Retained for archival re-runs against a reconstituted monolith.
 *
 * For entities with edgarCik but STILL no past events after all other
 * backfills (Yahoo earningsChart, Yahoo timeseries, SEC XBRL), use SEC
 * submissions to get real filing dates. Even if XBRL companyfacts
 * doesn't have per-quarter numbers, submissions has the FILING DATES
 * for every 6-K / 10-Q / 40-F / 20-F.
 *
 * These dates give the median-gap estimator a real historical rhythm
 * to project a next-event date. The past-event shells created here have
 * no metric values but real dates + real SEC filing URLs.
 *
 *   node scripts/backfill-sec-submissions-shells.mjs
 *   node scripts/backfill-sec-submissions-shells.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const CONCURRENCY = 3;
const SEC_UA = "Earnings Tracker (contact@example.com)";

const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };
const PERIODIC_FORMS = new Set(["10-Q", "10-K", "40-F", "20-F", "6-K"]);

async function fetchSubmissions(cik) {
  const padded = String(cik).padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function extractPeriodicFilings(sub) {
  const recent = sub.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const filed = recent.filingDate ?? [];
  const accession = recent.accessionNumber ?? [];
  const out = [];
  for (let i = 0; i < forms.length; i++) {
    if (!PERIODIC_FORMS.has(forms[i])) continue;
    out.push({ form: forms[i], filed: filed[i], accession: accession[i] });
  }
  return out;
}

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}
function periodFromDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return { year: y, quarter: q, label: `FY${y} Q${q}` };
}

function buildPastShell(entity, filedDate, filingForm, accession) {
  const { label } = periodFromDate(filedDate);
  const paddedCik = String(entity.edgarCik).padStart(10, "0");
  const sourceUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(filingForm)}`;
  const id = hashId(`${entity.ticker}_${filedDate}_${filingForm}`);
  const now = new Date().toISOString();
  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period: label,
    scheduledDate: filedDate,
    eventDate: filedDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "sec-submissions",
    provenanceAsOf: now,
    metrics: [
      {
        key: "filing_reference",
        displayLabel: `${filingForm} filing`,
        isHeadline: false,
        surprisePct: null,
        estimate: null,
        actual: {
          value: 1,
          unit: filingForm,
          source: {
            url: sourceUrl,
            label: `SEC EDGAR · ${filingForm} · ${accession ?? ""}`,
            provenance: "regulatory",
            locator: null,
          },
          asOf: filedDate,
          fetchedAt: now,
          method: "filing_manual",
          confidence: 0.99,
        },
        prior: null,
      },
    ],
    guidance: [],
    reaction: {
      benchmark: entity.benchmark ?? "",
      baselineDate: null,
      baselineClose: null,
      points: HORIZONS.map((h) => ({
        horizon: h,
        absReturn: null,
        excessReturn: null,
        benchmark: entity.benchmark ?? "",
        computedAt: null,
        populatesOn: addDays(filedDate, HORIZON_TRADING_DAYS[h] + 2),
      })),
    },
    sources: {
      windowStart: addDays(filedDate, -2),
      windowEnd: addDays(filedDate, 35),
      capturedAt: null,
      items: [],
      engineStatus: [],
    },
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`backfill-sec-submissions-shells · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));

  const pastEventTickers = new Set(
    snap.events.filter((ev) => ev.eventDate).map((ev) => ev.ticker),
  );
  const targets = reg.entities.filter(
    (e) =>
      e.edgarCik &&
      e.securityType === "operating" &&
      !pastEventTickers.has(e.ticker),
  );
  console.log(`Targets (edgarCik + no past events): ${targets.length}`);

  let eventsCreated = 0;
  let entitiesEnriched = 0;
  let noSubmissions = 0;
  let noFilings = 0;

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 25 === 0) {
      console.log(`  [${idx}/${targets.length}] · +${eventsCreated} shells`);
    }
    const sub = await fetchSubmissions(entity.edgarCik);
    if (!sub) { noSubmissions++; return; }
    const filings = extractPeriodicFilings(sub);
    if (filings.length === 0) { noFilings++; return; }
    // Merge key = (ticker, fiscalPeriod). Foreign filers submit multiple
    // 6-Ks per quarterly cycle (interim report + commentary + regulatory
    // notices), each with a distinct accessionNumber. Previously we did
    // `filings.slice(0, 4)` which produced 4 shells all landing on the
    // same 1-2 quarters. Group by fiscal period first, keep the earliest
    // filing per period (the actual earnings release), then take the
    // 4 most recent periods.
    const byPeriod = new Map();
    for (const f of filings) {
      if (!f.filed) continue;
      const { label } = periodFromDate(f.filed);
      if (!byPeriod.has(label)) byPeriod.set(label, []);
      byPeriod.get(label).push(f);
    }
    const periodEntries = [...byPeriod.entries()]
      .map(([label, group]) => ({
        label,
        // Earliest filing wins — it's usually the actual earnings
        // release; later filings in the same quarter are 6-K commentary.
        canonical: group
          .slice()
          .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0],
      }))
      .sort((a, b) => (b.canonical.filed ?? "").localeCompare(a.canonical.filed ?? ""))
      .slice(0, 4);
    let created = 0;
    for (const { canonical: f } of periodEntries) {
      const shell = buildPastShell(entity, f.filed, f.form, f.accession);
      snap.events.push(shell);
      eventsCreated++;
      created++;
    }
    if (created > 0) entitiesEnriched++;
  });

  console.log(`\nEntities enriched:   ${entitiesEnriched}`);
  console.log(`Shells created:      ${eventsCreated}`);
  console.log(`No submissions JSON: ${noSubmissions}`);
  console.log(`No periodic filings: ${noFilings}`);
  console.log(`Total events now:    ${snap.events.length}`);

  if (DRY) { console.log("Dry run — no write."); return; }
  await fs.writeFile(EARNINGS, JSON.stringify(snap, null, 2));
  console.log(`✓ wrote ${EARNINGS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
