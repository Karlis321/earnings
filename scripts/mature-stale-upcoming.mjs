#!/usr/bin/env node
/**
 * Promote "upcoming" events whose scheduledDate has slipped into the
 * past to their reported state by pulling Yahoo earningsChart data.
 *
 * Trigger: daily cron hasn't run in N days → shells stayed as
 * `eventDate: null` even though the company already released. Yahoo's
 * earningsChart returns { date, actual.raw, estimate.raw, periodEndDate,
 * reportedDate } per past quarter. If a quarter with an actual matches
 * an upcoming event's period, we:
 *   - set eventDate = reportedDate (real release date)
 *   - populate eps_usd.actual + eps_usd.surprisePct (if estimate present)
 *   - flip provenance markers so downstream reaction maturation runs
 *     the next time cron fires
 *
 *   node scripts/mature-stale-upcoming.mjs [--dry]
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

const DRY = process.argv.includes("--dry");
const TODAY = new Date();

const UA = "Mozilla/5.0 (mature-stale-upcoming)";
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
  // Check shared cache first (scripts/prime-yahoo-crumb.mjs writes it).
  try {
    const os = await import("node:os");
    const path = await import("node:path");
    const fsp = await import("node:fs/promises");
    const cachePath = path.default.join(os.default.tmpdir(), "yahoo-crumb.json");
    const raw = await fsp.default.readFile(cachePath, "utf-8");
    const cached = JSON.parse(raw);
    if (cached.crumb && cached.cookie && cached.expiresAt > Date.now()) {
      CRUMB = cached.crumb; COOKIE = cached.cookie; return CRUMB;
    }
  } catch { /* no cache */ }
  // Retry with backoff — see mature-any-reported.mjs.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
      const setCookies = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
      const pairs = new Map();
      for (const raw of setCookies) {
        const f = raw.split(";", 1)[0].trim();
        const eq = f.indexOf("=");
        if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
      }
      const cookie = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
      if (!cookie) { if (attempt < 3) await new Promise((r) => setTimeout(r, 2000)); continue; }
      const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
      if (!r2.ok) { if (attempt < 3) await new Promise((r) => setTimeout(r, 2000)); continue; }
      const crumb = (await r2.text()).trim();
      if (!crumb || /Unauthorized|<html/i.test(crumb)) { if (attempt < 3) await new Promise((r) => setTimeout(r, 2000)); continue; }
      COOKIE = cookie; CRUMB = crumb; return CRUMB;
    } catch { if (attempt < 3) await new Promise((r) => setTimeout(r, 2000)); }
  }
  return null;
}

async function fetchEarnings(symbol) {
  if (!CRUMB || !COOKIE) return { error: "no-crumb" };
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=earnings&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const quarterly = j?.quoteSummary?.result?.[0]?.earnings?.earningsChart?.quarterly ?? [];
    return { quarterly };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`mature-stale-upcoming · dry=${DRY}`);

  // Build target list: shards containing an upcoming event whose
  // scheduledDate is today or earlier. Group by ticker so we fetch
  // Yahoo once per shard.
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const targets = [];
  for (const f of files) {
    const shardPath = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { continue; }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const stale = events.filter(
      (e) => !e.eventDate && e.scheduledDate && new Date(e.scheduledDate) <= TODAY,
    );
    if (stale.length === 0) continue;
    const ticker = events[0]?.ticker ?? f.replace(/\.json$/, "").replace(/_/g, " ");
    const entity = byTicker.get(ticker);
    if (!entity?.yahooSymbol) continue;
    targets.push({ shardPath, shard, wrapped, events, stale, entity });
  }
  console.log(`Targets: ${targets.length} shards with stale upcoming events`);

  await primeCrumb();
  if (!CRUMB) { console.error("Yahoo crumb prime failed"); process.exit(1); }
  console.log(`crumb=${CRUMB.slice(0, 6)}…`);

  const rollup = {
    schema: "mature-stale-upcoming/v1",
    generatedAt: new Date().toISOString(),
    totals: { fetched: 0, matured: 0, shardsWritten: 0, noYahooMatch: 0, fetchErrors: 0 },
    matured: [],
  };
  const nowIso = new Date().toISOString();

  await pool(targets, CONCURRENCY, async (t) => {
    rollup.totals.fetched++;
    const r = await fetchEarnings(t.entity.yahooSymbol);
    if (r.error) { rollup.totals.fetchErrors++; return; }
    const quarterly = r.quarterly ?? [];

    let mutated = false;
    for (const stale of t.stale) {
      const q = quarterly.find((x) => {
        const p = periodFromEarningsLabel(x.date);
        return p && p.label === stale.period;
      });
      if (!q || q.actual?.raw == null || !q.reportedDate?.fmt) {
        rollup.totals.noYahooMatch++;
        continue;
      }
      // Promote to past event.
      stale.eventDate = q.reportedDate.fmt;
      stale.eventDateSource = "yahoo-earnings-chart-reportedDate";
      stale.freshness = "fresh";

      if (!Array.isArray(stale.metrics)) stale.metrics = [];
      let m = stale.metrics.find((x) => x.key === "eps_usd");
      if (!m) {
        m = {
          key: "eps_usd",
          displayLabel: "EPS",
          isHeadline: t.entity.headlineMetrics?.includes("eps_usd") ?? false,
          surprisePct: null,
          estimate: null,
          actual: null,
          prior: null,
        };
        stale.metrics.push(m);
      }
      m.actual = {
        value: q.actual.raw,
        unit: t.entity.currency ?? "USD",
        source: {
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(t.entity.yahooSymbol)}/earnings-history`,
          label: "Yahoo · earningsChart",
          provenance: "wire",
          locator: null,
        },
        asOf: q.periodEndDate?.fmt ?? stale.eventDate,
        fetchedAt: nowIso,
        method: "yahoo",
        confidence: 0.8,
      };
      if (q.estimate?.raw != null && (!m.estimate || m.estimate.value == null)) {
        m.estimate = {
          value: q.estimate.raw,
          unit: t.entity.currency ?? "USD",
          source: {
            url: `https://finance.yahoo.com/quote/${encodeURIComponent(t.entity.yahooSymbol)}/analysis`,
            label: "Yahoo · earningsChart (consensus)",
            provenance: "wire",
            locator: null,
          },
          asOf: q.periodEndDate?.fmt ?? stale.eventDate,
          fetchedAt: nowIso,
          method: "yahoo",
          confidence: 0.75,
        };
      }
      if (
        m.actual?.value != null &&
        m.estimate?.value != null &&
        Math.abs(m.estimate.value) > 1e-9
      ) {
        m.surprisePct = ((m.actual.value - m.estimate.value) / Math.abs(m.estimate.value)) * 100;
      }
      // Reset reaction — will be populated by next daily cron (or manually
      // via reaction maturation). Baseline anchor logic depends on timing
      // (BMO vs AMC) so we leave that to the cron's dedicated pass.
      stale.reaction = {
        benchmark: t.entity.benchmark ?? "",
        baselineDate: null,
        baselineClose: null,
        points: [
          { horizon: "d1", absReturn: null, excessReturn: null, benchmark: t.entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "d3", absReturn: null, excessReturn: null, benchmark: t.entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "w1", absReturn: null, excessReturn: null, benchmark: t.entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "m1", absReturn: null, excessReturn: null, benchmark: t.entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
        ],
      };
      // sourceLink for the newly matured event
      if (!stale.sourceLink) {
        stale.sourceLink = {
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(t.entity.yahooSymbol)}/earnings-history`,
          kind: "fallback",
        };
      }
      // Provenance
      stale.provenance = "yahoo-earnings-chart";
      stale.provenanceAsOf = nowIso;

      mutated = true;
      rollup.totals.matured++;
      rollup.matured.push({
        ticker: stale.ticker,
        period: stale.period,
        eventDate: stale.eventDate,
        actualEps: m.actual.value,
        estimateEps: m.estimate?.value ?? null,
        surprisePct: m.surprisePct,
      });
    }

    if (mutated && !DRY) {
      const body = t.wrapped ? { ...t.shard, events: t.events } : t.events;
      fssync.writeFileSync(t.shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  });

  console.log(`\n=== mature-stale-upcoming ===`);
  console.log(`Shards fetched:     ${rollup.totals.fetched}`);
  console.log(`Fetch errors:       ${rollup.totals.fetchErrors}`);
  console.log(`Events matured:     ${rollup.totals.matured}`);
  console.log(`Shards written:     ${rollup.totals.shardsWritten}`);
  console.log(`No Yahoo match:     ${rollup.totals.noYahooMatch}`);
  for (const e of rollup.matured) {
    console.log(`  ${e.ticker.padEnd(14)} ${e.period.padEnd(12)} eventDate=${e.eventDate} eps=${e.actualEps} est=${e.estimateEps ?? "—"} surp=${e.surprisePct?.toFixed(1) ?? "—"}%`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "mature-stale-upcoming.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/mature-stale-upcoming.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
