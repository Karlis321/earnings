#!/usr/bin/env node
/**
 * Backfill REAL report dates for every past event whose eventDate is
 * a quarter-end placeholder (2026-03-31, 2025-12-31, etc.) rather
 * than an actual filing/press-release date. The UI currently renders
 * these as "~Mar 2026 (est.)" via isEstimatedEventDate() because
 * sourceLink.kind is "fallback". Pull the actual filing date from
 * Yahoo earningsChart.quarterly[].reportedDate and update the shard.
 *
 * Priority per ticker:
 *   1. Yahoo earnings.earningsChart.quarterly.reportedDate — one
 *      call per Yahoo symbol, matches by period label (1Q2026 etc).
 *   2. If Yahoo has no data for a period, leave the placeholder.
 *      SEC submissions ingestion is orthogonal — the CIK path
 *      already sets real filing dates upstream.
 *
 * Marks eventDateSource on the metric so we don't overwrite already-
 * confirmed real dates.
 *
 *   node scripts/fetch-real-report-dates.mjs [--dry] [--limit=N]
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
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;
const ONLY = args.get("only")
  ? new Set(String(args.get("only")).split(",").map((t) => t.trim()))
  : null;
const SP500_ONLY = args.get("sp500-only") === true;

const UA = "Mozilla/5.0 (fetch-real-report-dates)";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function periodFromEarningsLabel(label) {
  const m = /^(\d)Q(\d{4})$/.exec(label ?? "");
  if (!m) return null;
  return { label: `FY${m[2]} Q${m[1]}` };
}

// An event has a "placeholder" eventDate if it looks like quarter-end
// (last-day-of-quarter month) AND sourceLink is fallback-kind.
// eventDateSource === "yahoo-earnings-chart-reportedDate" means it was
// already backfilled — skip.
function isPlaceholder(event) {
  if (!event.eventDate) return false;
  if (event.eventDateSource === "yahoo-earnings-chart-reportedDate") return false;
  // Any MONTH-END date is a candidate placeholder — fiscal-offset
  // issuers land on non-calendar-quarter month-ends (AVGO 04-30/07-31/
  // 10-31/01-31, NVDA 04-30/07-31/10-31/01-31, WMT 04-30 etc.), so
  // restricting to calendar-quarter-ends missed the entire fiscal-
  // offset population. Real filing dates are almost never on the last
  // day of a month (10-Qs typically file mid-month or later), so this
  // false-positive risk is bounded.
  // NB: this fires even when sourceLink.kind === "filing" — since
  // the eventDate can be stale even after a filing was attached
  // (attach-sec-filings didn't back-update eventDate).
  const d = new Date(event.eventDate);
  const day = d.getUTCDate();
  // Last day of month test — d.getUTCMonth() returns 0-11 and
  // (day 28/29/30/31 depending on month + Feb).
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return day === daysInMonth;
}

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const cs = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of cs) { const f = raw.split(";", 1)[0].trim(); const eq = f.indexOf("="); if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1)); }
  COOKIE = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: COOKIE } });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}
async function fetchEarnings(symbol) {
  if (!CRUMB || !COOKIE) return { error: "no-crumb" };
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earnings&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: COOKIE }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return { quarterly: j?.quoteSummary?.result?.[0]?.earnings?.earningsChart?.quarterly ?? [] };
  } catch (e) { return { error: e.message ?? "network" }; }
}
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`fetch-real-report-dates · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT} concurrency=${CONCURRENCY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter(
    (e) =>
      e.securityType === "operating" &&
      typeof e.yahooSymbol === "string" &&
      e.yahooSymbol &&
      (!ONLY || ONLY.has(e.ticker)) &&
      (!SP500_ONLY || (e.index_membership ?? []).includes("SP500")),
  );

  // Collect tickers that have at least one placeholder past event.
  const targets = [];
  for (const entity of entities) {
    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let shard;
    try { shard = JSON.parse(fssync.readFileSync(shardPath, "utf-8")); } catch { continue; }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const placeholders = events.filter(isPlaceholder);
    if (placeholders.length === 0) continue;
    targets.push({ entity, shardPath, shard, wrapped, events, placeholders });
    if (targets.length >= LIMIT) break;
  }
  console.log(`Targets: ${targets.length} shards with placeholder eventDates`);

  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }

  const nowIso = new Date().toISOString();
  const rollup = {
    schema: "fetch-real-report-dates/v1",
    generatedAt: nowIso,
    totals: { fetched: 0, fetchErrors: 0, datesUpdated: 0, shardsWritten: 0 },
    updates: [],
  };

  let processed = 0;
  await pool(targets, CONCURRENCY, async (t) => {
    processed++;
    const r = await fetchEarnings(t.entity.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) { rollup.totals.fetchErrors++; return; }
    const q = r.quarterly ?? [];
    if (q.length === 0) return;

    let mutated = false;
    for (const stale of t.placeholders) {
      // The placeholder eventDate IS the fiscal quarter-end that
      // Yahoo timeseries stamped. Match by periodEndDate ONLY (must
      // be within 3 days of our stored value) — label matching is
      // ambiguous for fiscal-offset issuers ("2Q2026" can mean
      // CRWD's May-Jul 2025 OR our calendar Apr-Jun 2026). Then
      // require the reportedDate to be within 90 days AFTER the
      // periodEnd (real filings land 2-8 weeks after quarter close).
      let match = null;
      for (const x of q) {
        if (!x.periodEndDate?.fmt) continue;
        const periodEndGap = Math.abs(
          new Date(x.periodEndDate.fmt) - new Date(stale.eventDate),
        ) / 86_400_000;
        if (periodEndGap > 3) continue;
        match = x;
        break;
      }
      if (!match || !match.reportedDate?.fmt) continue;
      const newDate = match.reportedDate.fmt;
      if (newDate === stale.eventDate) continue;
      // Sanity check: reportedDate should be AFTER quarter end and
      // within 90 days. If Yahoo returned something wildly off (this
      // has been observed on foreign tickers), reject.
      const forwardShift = (new Date(newDate) - new Date(stale.eventDate)) / 86_400_000;
      if (forwardShift < 0 || forwardShift > 90) continue;
      const prev = stale.eventDate;
      stale.eventDate = newDate;
      stale.eventDateSource = "yahoo-earnings-chart-reportedDate";
      stale._quarterEndDate = prev;
      mutated = true;
      rollup.totals.datesUpdated++;
      rollup.updates.push({ ticker: stale.ticker, period: stale.period, from: prev, to: newDate });
    }

    if (mutated && !DRY) {
      const body = t.wrapped ? { ...t.shard, events: t.events } : t.events;
      fssync.writeFileSync(t.shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }

    if (processed % 100 === 0) {
      console.log(`  ${processed}/${targets.length} · dates=${rollup.totals.datesUpdated} · shards=${rollup.totals.shardsWritten}`);
    }
  });

  console.log(`\n=== fetch-real-report-dates ===`);
  console.log(`Fetched:         ${rollup.totals.fetched}`);
  console.log(`Fetch errors:    ${rollup.totals.fetchErrors}`);
  console.log(`Dates updated:   ${rollup.totals.datesUpdated}`);
  console.log(`Shards written:  ${rollup.totals.shardsWritten}`);
  console.log(`\nSample updates:`);
  for (const u of rollup.updates.slice(0, 20)) console.log(`  ${u.ticker.padEnd(14)} ${u.period.padEnd(12)} ${u.from} → ${u.to}`);
  if (rollup.updates.length > 20) console.log(`  … +${rollup.updates.length - 20} more`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "fetch-real-report-dates.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/fetch-real-report-dates.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
