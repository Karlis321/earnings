#!/usr/bin/env node
/**
 * Phase 4 mechanical fix: attach real SEC filing sourceLinks to past
 * events that currently carry a fallback/search/null sourceLink but
 * have real actuals AND a CIK on the entity. EDGAR's submissions
 * endpoint is deterministic:
 *
 *   https://data.sec.gov/submissions/CIK<0-padded 10>.json
 *   → { filings: { recent: { form[], filingDate[], accessionNumber[],
 *                            primaryDocument[], ...} } }
 *
 * Matches an event's eventDate to the recent filings and picks the
 * best-fit filing (preferring 8-K with press-release exhibit over
 * 10-Q/10-K on the announcement day). Only stores a sourceLink when
 * the accession URL returns 200 on probe.
 *
 * Rate: SEC 1 req/s. --scope=sp500-latest (default) touches just the
 * latest quarter of the 503 SP500 members (~8-9 min). --scope=all
 * would touch every hole (~2h+, resumable via a checkpoint file).
 *
 *   node scripts/attach-sec-filings.mjs                     # sp500-latest
 *   node scripts/attach-sec-filings.mjs --scope=sp500-all   # all 5 quarters
 *   node scripts/attach-sec-filings.mjs --scope=all         # every violation
 *   node scripts/attach-sec-filings.mjs --dry-run
 *   node scripts/attach-sec-filings.mjs --limit=50
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const AUDIT_PATH = path.join(ROOT, "scripts", "audits", "attach-sec-filings.json");
const CHECKPOINT_PATH = path.join(ROOT, "fetched", "attach-sec-filings.checkpoint.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SCOPE = args.find((a) => a.startsWith("--scope="))?.slice(8) ?? "sp500-latest";
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0) || null;
// SEC EDGAR fair-access — real contact email required; example.com
// gets soft-blocked after sustained querying.
const SEC_UA = `earnings-dashboard ${process.env.EDGAR_CONTACT_EMAIL || "klpp@bluorbank.lv"}`;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

let secLastFetchAt = 0;
async function fetchEdgarJson(url) {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - secLastFetchAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  secLastFetchAt = Date.now();
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function probeUrl(url) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": SEC_UA },
      signal: AbortSignal.timeout(8000),
    });
    return r.status >= 200 && r.status < 400;
  } catch {
    return false;
  }
}

function submissionsUrl(cik) {
  return `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;
}

function olderPageUrl(name) {
  return `https://data.sec.gov/submissions/${name}`;
}

// Merge a paginated older-submissions page into the same
// {form[], filingDate[], accessionNumber[], primaryDocument[],
//  reportDate[]} shape pickBestFiling expects.
function mergeSubmissionsPage(recent, pageData) {
  if (!pageData) return recent;
  const keys = ["form", "filingDate", "accessionNumber", "primaryDocument", "reportDate"];
  for (const k of keys) {
    if (Array.isArray(pageData[k])) {
      recent[k] = (recent[k] ?? []).concat(pageData[k]);
    }
  }
  return recent;
}

function accessionUrl(cik, accessionRaw, primaryDoc) {
  const bareCik = String(cik).replace(/^0+/, "");
  const bareAcc = String(accessionRaw).replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${bareCik}/${bareAcc}/${primaryDoc}`;
}

function pickBestFiling(recent, eventDateIso) {
  // Prefer 8-K on/near the event date (that's the announcement doc).
  // Fall back to 10-Q/10-K for the fiscal period.
  const rows = [];
  const n = recent.form.length;
  for (let i = 0; i < n; i++) {
    rows.push({
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      accession: recent.accessionNumber[i],
      primaryDoc: recent.primaryDocument[i],
      reportDate: recent.reportDate?.[i],
    });
  }
  const relevant = rows.filter((r) => /^(8-K|10-Q|10-K|20-F|40-F|6-K)$/.test(r.form));
  const scored = relevant.map((r) => {
    // TWO gap dimensions:
    //   - filingGap: SEC filing timestamp vs our event date (Yahoo
    //     usually stamps this reasonably accurately for calendar-
    //     quarter issuers).
    //   - reportGap: SEC's own reportDate (fiscal period end) vs
    //     our event date. For fiscal-offset issuers (Accenture,
    //     Applied Materials, etc.), Yahoo stores the fiscal
    //     quarter-end as eventDate — the SEC reportDate on the
    //     matching 10-Q will be identical. This dimension nails
    //     fiscal-offset issuers.
    // Score off the SMALLER of the two — whichever anchor Yahoo
    // used to stamp eventDate, one of the two will be near-zero.
    const filingGap = daysBetween(r.filingDate, eventDateIso);
    const reportGap = r.reportDate ? daysBetween(r.reportDate, eventDateIso) : filingGap + 1000;
    const gap = Math.min(filingGap, reportGap);
    let score = 100 - gap;
    if (r.form === "8-K") score += 5;
    if (r.form === "10-Q") score += 3;
    if (r.form === "10-K") score += 3;
    if (r.form === "20-F" || r.form === "40-F") score += 2;
    if (r.form === "6-K") score += 1;
    // 100-day window on the BEST of the two gap dimensions.
    // Widened from 30d after the R1000-batch triage: fiscal-offset
    // issuers stamped by Yahoo at fiscal-quarter END (e.g. Sep 30)
    // versus SEC's own reportDate/filingDate on the next 10-Q
    // (Dec 31 filed Feb) land at exactly ~91-92 days off. The
    // form-type bonus + minimum-of-two gap dimensions already keep
    // false matches out — the wider window just lets the correct
    // 10-Q qualify. Cases like LLYVK/GLIBA (Liberty Media tracker
    // stocks with fiscal-offset labeling) were the surfacing bug.
    if (gap > 100) score -= 100;
    return { ...r, score, gap, filingGap, reportGap };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.gap <= 100 ? scored[0] : null;
}

async function loadShardObject(ticker) {
  const p = path.join(EVENTS_DIR, tickerSlug(ticker) + ".json");
  try {
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    return { path: p, wrapped: !Array.isArray(j), body: j };
  } catch {
    return null;
  }
}

async function loadCheckpoint() {
  try {
    const j = JSON.parse(await fs.readFile(CHECKPOINT_PATH, "utf-8"));
    return new Set(j.completed ?? []);
  } catch {
    return new Set();
  }
}
async function saveCheckpoint(completed) {
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
  await fs.writeFile(
    CHECKPOINT_PATH,
    JSON.stringify({ completed: [...completed] }, null, 2),
  );
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  const checkpoint = await loadCheckpoint();

  // Build the ticker set based on scope.
  let candidateTickers;
  if (SCOPE === "sp500-latest" || SCOPE === "sp500-all") {
    candidateTickers = entities
      .filter((e) => (e.index_membership ?? []).includes("SP500") && e.edgarCik)
      .map((e) => e.ticker);
  } else if (SCOPE === "indexed-latest") {
    // SP500 + R1000 union, latest quarter only. Daily-cron budget:
    // ~1,000 tickers with CIK * 1 req/s = ~17 min. Catches R1000
    // violations that sp500-latest misses (CNH/INSP/JAZZ/PPLI class).
    candidateTickers = entities
      .filter((e) => {
        const idx = e.index_membership ?? [];
        return (idx.includes("SP500") || idx.includes("R1000")) && e.edgarCik;
      })
      .map((e) => e.ticker);
  } else if (SCOPE === "all") {
    candidateTickers = entities.filter((e) => e.edgarCik).map((e) => e.ticker);
  } else {
    console.error(`unknown --scope=${SCOPE}`);
    process.exit(1);
  }
  // sp500-latest: only newest quarter per ticker (fastest verify pass).
  // sp500-all / all: no depth cap — process every past event on the
  // shard. The previous 5-event cap missed older events (WMT US
  // FY2025 Q1/Q2 sat at indices 6-7 and were never touched).
  const historyDepth = (SCOPE === "sp500-latest" || SCOPE === "indexed-latest") ? 1 : Infinity;
  if (LIMIT) candidateTickers = candidateTickers.slice(0, LIMIT);
  console.log(`scope=${SCOPE} · candidates=${candidateTickers.length} · depth=${historyDepth} · checkpoint had ${checkpoint.size} completed`);

  const rollup = {
    schema: "attach-sec-filings/v1",
    generatedAt: new Date().toISOString(),
    scope: SCOPE,
    dry: DRY,
    tickers_processed: 0,
    tickers_no_submissions: 0,
    events_examined: 0,
    events_attached: 0,
    events_no_match: 0,
    events_probe_failed: 0,
    events_already_ok: 0,
    updates: [],
  };

  for (const ticker of candidateTickers) {
    if (checkpoint.has(ticker)) { rollup.tickers_processed++; continue; }
    const entity = entities.find((e) => e.ticker === ticker);
    if (!entity?.edgarCik) continue;
    const shard = await loadShardObject(ticker);
    if (!shard) continue;
    const events = shard.wrapped ? shard.body.events : shard.body;
    const past = events
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""))
      .slice(0, historyDepth);
    const violating = past.filter((e) => {
      const hasActuals = (e.metrics ?? []).some((m) => m.actual?.value != null);
      const link = e.sourceLink;
      const ok = link && link.kind === "filing" && link.url && !/google\.com\/search/i.test(link.url);
      return hasActuals && !ok;
    });
    if (violating.length === 0) {
      rollup.events_already_ok += past.length;
      checkpoint.add(ticker);
      rollup.tickers_processed++;
      continue;
    }
    const subs = await fetchEdgarJson(submissionsUrl(entity.edgarCik));
    if (!subs?.filings?.recent) {
      rollup.tickers_no_submissions++;
      rollup.tickers_processed++;
      continue;
    }
    // High-volume filers (banks, real estate cos.) can push older
    // 10-Q filings off the ~1000-entry recent bucket. When we need
    // to reach for a filing that's older than what recent covers,
    // walk the pagination pages (filings.files[]) — each covers a
    // date range so we only fetch pages whose window includes the
    // ev.eventDate we're trying to match.
    const combinedFilings = { ...subs.filings.recent };
    const olderPages = (subs.filings.files ?? []).slice();
    const oldestRecent = subs.filings.recent.filingDate?.length > 0
      ? subs.filings.recent.filingDate[subs.filings.recent.filingDate.length - 1]
      : null;
    let mutated = false;
    for (const ev of violating) {
      rollup.events_examined++;
      let filing = pickBestFiling(combinedFilings, ev.eventDate);
      // If not found in recent bucket AND the event predates our
      // deepest recent filing, walk older pages until we find a
      // window that could contain the event's target filing.
      if (!filing && oldestRecent && ev.eventDate < oldestRecent) {
        for (const pageMeta of olderPages) {
          if (!pageMeta.filingFrom || !pageMeta.filingTo) continue;
          const eventTs = new Date(ev.eventDate).getTime();
          const fromTs = new Date(pageMeta.filingFrom).getTime();
          const toTs = new Date(pageMeta.filingTo).getTime();
          if (eventTs < fromTs - 60 * 86_400_000) continue;
          if (eventTs > toTs + 60 * 86_400_000) continue;
          const pageData = await fetchEdgarJson(olderPageUrl(pageMeta.name));
          if (pageData) mergeSubmissionsPage(combinedFilings, pageData);
          filing = pickBestFiling(combinedFilings, ev.eventDate);
          if (filing) break;
        }
      }
      if (!filing) { rollup.events_no_match++; continue; }
      const url = accessionUrl(entity.edgarCik, filing.accession, filing.primaryDoc);
      const probeOk = await probeUrl(url);
      if (!probeOk) { rollup.events_probe_failed++; continue; }
      // Attach.
      ev.sourceLink = {
        kind: "filing",
        url,
        // Preserve traceability.
        form: filing.form,
        accession: filing.accession,
        filingDate: filing.filingDate,
      };
      rollup.events_attached++;
      rollup.updates.push({ ticker, period: ev.period, eventDate: ev.eventDate, form: filing.form, filingDate: filing.filingDate });
      mutated = true;
    }
    if (mutated && !DRY) {
      const body = shard.wrapped ? { ...shard.body, events } : events;
      await fs.writeFile(shard.path, JSON.stringify(body, null, 2));
    }
    checkpoint.add(ticker);
    rollup.tickers_processed++;
    if (rollup.tickers_processed % 25 === 0) {
      await saveCheckpoint(checkpoint);
      console.log(`  ${rollup.tickers_processed}/${candidateTickers.length} · attached=${rollup.events_attached} · no-match=${rollup.events_no_match} · probe-fail=${rollup.events_probe_failed}`);
    }
  }
  await saveCheckpoint(checkpoint);

  console.log(`\n=== attach-sec-filings · ${SCOPE} ===`);
  console.log(`  tickers processed:      ${rollup.tickers_processed}`);
  console.log(`  tickers no-submissions: ${rollup.tickers_no_submissions}`);
  console.log(`  events examined:        ${rollup.events_examined}`);
  console.log(`  events attached:        ${rollup.events_attached}`);
  console.log(`  events no-match:        ${rollup.events_no_match}`);
  console.log(`  events probe-failed:    ${rollup.events_probe_failed}`);
  console.log(`  events already-ok:      ${rollup.events_already_ok}`);

  await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await fs.writeFile(AUDIT_PATH, JSON.stringify(rollup, null, 2));
  console.log(`  audit → ${path.relative(ROOT, AUDIT_PATH)}`);
}

main().catch((e) => {
  console.error(`::error::attach-sec-filings crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
