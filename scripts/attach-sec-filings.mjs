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
const SEC_UA = "earnings-dashboard karlis@example.com";

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
  // Score: same-day 8-K > within-3-day 8-K > same-day 10-Q > within-3-day 10-Q > 10-K > 6-K etc.
  const scored = relevant.map((r) => {
    const gap = daysBetween(r.filingDate, eventDateIso);
    let score = 100 - gap;
    if (r.form === "8-K") score += 5;
    if (r.form === "10-Q") score += 3;
    if (r.form === "10-K") score += 3;
    if (r.form === "20-F" || r.form === "40-F") score += 2;
    if (r.form === "6-K") score += 1;
    // 30-day window catches fiscal-offset issuers where Yahoo's
    // quarter-end placeholder can sit ~3-4 weeks before the actual
    // filing (Accenture Q2 ends Feb but files in March/April, etc.).
    // Beyond 30 days we're likely picking up an adjacent quarter's
    // filing — hard penalty.
    if (gap > 30) score -= 100;
    return { ...r, score, gap };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.gap <= 30 ? scored[0] : null;
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
  } else if (SCOPE === "all") {
    candidateTickers = entities.filter((e) => e.edgarCik).map((e) => e.ticker);
  } else {
    console.error(`unknown --scope=${SCOPE}`);
    process.exit(1);
  }
  const historyDepth = SCOPE === "sp500-latest" ? 1 : 5;
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
    let mutated = false;
    for (const ev of violating) {
      rollup.events_examined++;
      const filing = pickBestFiling(subs.filings.recent, ev.eventDate);
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
