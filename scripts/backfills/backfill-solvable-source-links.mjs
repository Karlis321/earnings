#!/usr/bin/env node
/**
 * Backfill sourceLink for the "solvable" bucket of
 * reported_without_document events.
 *
 * "Solvable" per pipelineReport.ts / run-pipeline-check.mjs:
 *   - event has actuals (>=1 metric.actual.value != null)
 *   - event.eventDate present
 *   - ticker.endsWith(" US")
 *   - entity has edgarCik
 *   - entity.secFilerType is NOT "foreign" or "pre-listing"
 *   - event.sourceLink is absent OR kind !== "filing" OR is a
 *     google.com/search fallback URL
 *
 * For each such event, hit SEC EDGAR's submissions.json for the
 * CIK, pick the best-matching filing (10-Q / 10-K preferred; 8-K
 * fallback for earnings releases), and stamp
 *   sourceLink = { kind: "filing", url: "<sec.gov archive path>" }
 *
 * Fair-access: 1.1s between SEC requests; contact-bearing UA per
 * EDGAR policy. See scripts/fetch-edgar.mjs for the same pattern
 * in shell-invocation form.
 *
 *   node scripts/backfills/backfill-solvable-source-links.mjs --dry
 *   node scripts/backfills/backfill-solvable-source-links.mjs
 *
 * Writes audit to scripts/audits/backfill-solvable-source-links.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const AUDIT_PATH = path.join(ROOT, "scripts", "audits", "backfill-solvable-source-links.json");

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

function buildFilingUrl(cik, accession, primaryDoc) {
  const cikNoZeros = String(cik).replace(/\D/g, "").replace(/^0+/, "") || "0";
  const acc = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${acc}/${primaryDoc}`;
}

function daysBetween(iso1, iso2) {
  if (!iso1 || !iso2) return Infinity;
  const t1 = new Date(iso1 + "T00:00:00Z").getTime();
  const t2 = new Date(iso2 + "T00:00:00Z").getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Infinity;
  return Math.abs(t1 - t2) / 86_400_000;
}

async function fetchSubmissions(cik) {
  const url = `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
  const res = await throttledFetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SEC ${res.status} ${res.statusText} · ${body.slice(0, 120)}`);
  }
  return await res.json();
}

function flattenRecent(submissions) {
  const r = submissions.filings?.recent;
  if (!r || !Array.isArray(r.form)) return [];
  const items = [];
  for (let i = 0; i < r.form.length; i++) {
    items.push({
      form: r.form[i],
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i],
      accession: r.accessionNumber[i],
      primaryDoc: r.primaryDocument[i],
    });
  }
  return items;
}

function pickFiling(submissions, eventDate) {
  const items = flattenRecent(submissions);
  if (items.length === 0) return null;
  const isPeriodic = (f) =>
    f === "10-Q" || f === "10-K" || f === "10-Q/A" || f === "10-K/A" || f === "20-F" || f === "40-F";
  const periodic = items.filter((x) => isPeriodic(x.form));
  const eightK = items.filter((x) => x.form === "8-K");

  // 1. Exact reportDate match on a periodic filing.
  const exact = periodic.find((x) => x.reportDate === eventDate);
  if (exact) return { ...exact, matchKind: "reportDate-exact" };

  // 2. Periodic within ±7 days on reportDate.
  const closeReport = periodic
    .map((x) => ({ ...x, gap: daysBetween(x.reportDate, eventDate) }))
    .filter((x) => x.gap <= 7)
    .sort((a, b) => a.gap - b.gap);
  if (closeReport.length) return { ...closeReport[0], matchKind: "reportDate-close" };

  // 3. Periodic within ±35 days on filingDate.
  const closeFile = periodic
    .map((x) => ({ ...x, gap: daysBetween(x.filingDate, eventDate) }))
    .filter((x) => x.gap <= 35)
    .sort((a, b) => a.gap - b.gap);
  if (closeFile.length) return { ...closeFile[0], matchKind: "filingDate-35d" };

  // 4. 8-K within ±10 days on filingDate (earnings release).
  const close8k = eightK
    .map((x) => ({ ...x, gap: daysBetween(x.filingDate, eventDate) }))
    .filter((x) => x.gap <= 10)
    .sort((a, b) => a.gap - b.gap);
  if (close8k.length) return { ...close8k[0], matchKind: "8k-10d" };

  return null;
}

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

async function main() {
  console.log(`backfill-solvable-source-links · dry=${DRY} · ua="${UA}"`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entByTicker = new Map((reg.entities ?? []).map((e) => [e.ticker, e]));

  const shardFiles = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const solvableByCik = new Map();
  const shardCache = new Map();

  for (const f of shardFiles) {
    const p = path.join(EVENTS_DIR, f);
    let shard;
    try {
      shard = JSON.parse(await fs.readFile(p, "utf-8"));
    } catch {
      continue;
    }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    let anySolvable = false;
    for (const ev of events) {
      if (!ev?.eventDate || !ev.ticker) continue;
      if (!ev.ticker.endsWith(" US")) continue;
      const ent = entByTicker.get(ev.ticker);
      if (!ent?.edgarCik) continue;
      if (ent.secFilerType === "foreign" || ent.secFilerType === "pre-listing") continue;
      const hasActuals = (ev.metrics ?? []).some((m) => m.actual?.value != null);
      if (!hasActuals) continue;
      const link = ev.sourceLink;
      const ok = link && link.kind === "filing" && link.url && !/google\.com\/search/i.test(link.url);
      if (ok) continue;
      anySolvable = true;
      const cik = ent.edgarCik;
      if (!solvableByCik.has(cik)) solvableByCik.set(cik, []);
      solvableByCik.get(cik).push({ ev, ticker: ev.ticker });
    }
    if (anySolvable) {
      shardCache.set(f, { shardPath: p, shardBody: shard, wrapped, events });
    }
  }

  const eventsTargeted = [...solvableByCik.values()].reduce((s, v) => s + v.length, 0);
  console.log(
    `Targeting ${eventsTargeted} events across ${solvableByCik.size} CIKs · ${shardCache.size} shards.`,
  );

  const audit = {
    schema: "backfill-solvable-source-links/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    totals: {
      events_targeted: eventsTargeted,
      ciks_attempted: solvableByCik.size,
      ciks_fetched: 0,
      events_linked: 0,
      events_unmatched: 0,
      fetch_errors: 0,
    },
    matched: [],
    unmatched: [],
    fetchErrors: [],
  };

  const mutatedShards = new Set();
  const ciks = [...solvableByCik.keys()];
  for (let i = 0; i < ciks.length; i++) {
    const cik = ciks[i];
    const list = solvableByCik.get(cik);
    const preview = list[0].ticker;
    process.stdout.write(`  [${i + 1}/${ciks.length}] CIK ${cik} · ${list.length} events · ${preview}`);
    let submissions;
    try {
      submissions = await fetchSubmissions(cik);
    } catch (e) {
      console.log(` · ERROR: ${e.message}`);
      audit.totals.fetch_errors++;
      audit.fetchErrors.push({ cik, ticker: preview, error: e.message });
      continue;
    }
    audit.totals.ciks_fetched++;
    let linkedHere = 0;
    for (const { ev, ticker } of list) {
      const match = pickFiling(submissions, ev.eventDate);
      if (!match) {
        audit.totals.events_unmatched++;
        audit.unmatched.push({ ticker, period: ev.period, eventDate: ev.eventDate, cik });
        continue;
      }
      const url = buildFilingUrl(cik, match.accession, match.primaryDoc);
      ev.sourceLink = { kind: "filing", url };
      audit.totals.events_linked++;
      audit.matched.push({
        ticker,
        period: ev.period,
        eventDate: ev.eventDate,
        form: match.form,
        reportDate: match.reportDate,
        filingDate: match.filingDate,
        matchKind: match.matchKind,
        gap: match.gap ?? null,
        url,
      });
      const slug = tickerSlug(ticker);
      const shardKey = slug + ".json";
      if (shardCache.has(shardKey)) mutatedShards.add(shardKey);
      linkedHere++;
    }
    console.log(` · linked ${linkedHere}/${list.length}`);
  }

  if (!DRY) {
    let writtenCount = 0;
    for (const key of mutatedShards) {
      const meta = shardCache.get(key);
      if (!meta) continue;
      const body = meta.wrapped ? { ...meta.shardBody, events: meta.events } : meta.events;
      await fs.writeFile(meta.shardPath, JSON.stringify(body, null, 2));
      writtenCount++;
    }
    console.log(`\nWrote ${writtenCount} shards.`);
  } else {
    console.log(`\n(dry run — would write ${mutatedShards.size} shards)`);
  }

  await fs.writeFile(AUDIT_PATH, JSON.stringify(audit, null, 2));
  console.log(`\n=== done ===`);
  console.log(`  events targeted:  ${audit.totals.events_targeted}`);
  console.log(`  CIKs attempted:   ${audit.totals.ciks_attempted}`);
  console.log(`  CIKs fetched:     ${audit.totals.ciks_fetched}`);
  console.log(`  events linked:    ${audit.totals.events_linked}`);
  console.log(`  events unmatched: ${audit.totals.events_unmatched}`);
  console.log(`  fetch errors:     ${audit.totals.fetch_errors}`);
  console.log(`  audit →           ${path.relative(ROOT, AUDIT_PATH)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
