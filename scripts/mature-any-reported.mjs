#!/usr/bin/env node
/**
 * Broader-net maturation than mature-stale-upcoming.mjs. That
 * script only touched shells whose scheduledDate was already past.
 * But Yahoo's earnings calendar can be miles off: MSFT/META reported
 * 2026-07-29 with our shell scheduledDate stamped 2026-09-29 (a
 * mid-quarter estimator placeholder). Those never got matured.
 *
 * This one hits Yahoo earningsChart for EVERY operating ticker,
 * matches any past-period entries with an actual to our upcoming
 * shells by period label, and promotes them regardless of what our
 * scheduledDate said.
 *
 *   node scripts/mature-any-reported.mjs [--dry] [--limit=N]
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

const UA = "Mozilla/5.0 (mature-any-reported)";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function periodFromEarningsLabel(label) {
  const m = /^(\d)Q(\d{4})$/.exec(label ?? "");
  if (!m) return null;
  return { quarter: Number(m[1]), year: Number(m[2]), label: `FY${m[2]} Q${m[1]}` };
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
  console.log(`mature-any-reported · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT} concurrency=${CONCURRENCY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter((e) => e.securityType === "operating" && typeof e.yahooSymbol === "string" && e.yahooSymbol).slice(0, LIMIT);

  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }

  const nowIso = new Date().toISOString();
  const rollup = { schema: "mature-any-reported/v1", generatedAt: nowIso, totals: { fetched: 0, fetchErrors: 0, matured: 0, shardsWritten: 0 }, matured: [] };

  let processed = 0;
  await pool(entities, CONCURRENCY, async (entity) => {
    processed++;
    const r = await fetchEarnings(entity.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) { rollup.totals.fetchErrors++; return; }
    const q = r.quarterly ?? [];
    if (q.length === 0) return;

    // Load shard
    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { return; }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const originalJson = JSON.stringify(events);

    let mutated = false;
    for (const yQ of q) {
      if (yQ.actual?.raw == null || !yQ.reportedDate?.fmt) continue;
      const p = periodFromEarningsLabel(yQ.date);
      if (!p) continue;
      // Match an UPCOMING (no eventDate) event with this period label.
      const target = events.find((e) => !e.eventDate && e.period === p.label);
      if (!target) continue;
      // Promote.
      target.eventDate = yQ.reportedDate.fmt;
      target.eventDateSource = "yahoo-earnings-chart-reportedDate";
      target.freshness = "fresh";
      if (!Array.isArray(target.metrics)) target.metrics = [];
      let m = target.metrics.find((x) => x.key === "eps_usd");
      if (!m) {
        m = { key: "eps_usd", displayLabel: "EPS", isHeadline: entity.headlineMetrics?.includes("eps_usd") ?? false, surprisePct: null, estimate: null, actual: null, prior: null };
        target.metrics.push(m);
      }
      m.actual = {
        value: yQ.actual.raw,
        unit: entity.currency ?? "USD",
        source: { url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/earnings-history`, label: "Yahoo · earningsChart", provenance: "wire", locator: null },
        asOf: yQ.periodEndDate?.fmt ?? target.eventDate,
        fetchedAt: nowIso,
        method: "yahoo",
        confidence: 0.8,
      };
      if (yQ.estimate?.raw != null && (!m.estimate || m.estimate.value == null)) {
        m.estimate = {
          value: yQ.estimate.raw,
          unit: entity.currency ?? "USD",
          source: { url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/analysis`, label: "Yahoo · earningsChart (consensus)", provenance: "wire", locator: null },
          asOf: yQ.periodEndDate?.fmt ?? target.eventDate,
          fetchedAt: nowIso,
          method: "yahoo",
          confidence: 0.75,
        };
      }
      if (m.actual?.value != null && m.estimate?.value != null && Math.abs(m.estimate.value) > 1e-9) {
        m.surprisePct = ((m.actual.value - m.estimate.value) / Math.abs(m.estimate.value)) * 100;
      }
      target.reaction = {
        benchmark: entity.benchmark ?? "",
        baselineDate: null,
        baselineClose: null,
        points: [
          { horizon: "d1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "d3", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "w1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "m1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
        ],
      };
      if (!target.sourceLink) {
        target.sourceLink = { url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/earnings-history`, kind: "fallback" };
      }
      target.provenance = "yahoo-earnings-chart";
      target.provenanceAsOf = nowIso;
      mutated = true;
      rollup.totals.matured++;
      rollup.matured.push({ ticker: target.ticker, period: target.period, eventDate: target.eventDate, actualEps: m.actual.value, estimateEps: m.estimate?.value ?? null, surprisePct: m.surprisePct });
    }

    if (mutated && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
    if (processed % 100 === 0) console.log(`  ${processed}/${entities.length} · matured=${rollup.totals.matured}`);
  });

  console.log(`\n=== mature-any-reported ===`);
  console.log(`Fetched:        ${rollup.totals.fetched}`);
  console.log(`Fetch errors:   ${rollup.totals.fetchErrors}`);
  console.log(`Matured:        ${rollup.totals.matured}`);
  console.log(`Shards written: ${rollup.totals.shardsWritten}`);
  for (const m of rollup.matured.slice(0, 40)) console.log(`  ${m.ticker.padEnd(14)} ${m.period.padEnd(12)} @${m.eventDate} eps=${m.actualEps} est=${m.estimateEps ?? "—"} surp=${m.surprisePct?.toFixed(1) ?? "—"}%`);
  if (rollup.matured.length > 40) console.log(`  … +${rollup.matured.length - 40} more`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "mature-any-reported.json"), JSON.stringify(rollup, null, 2));
  console.log(`✓ audit → scripts/audits/mature-any-reported.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
