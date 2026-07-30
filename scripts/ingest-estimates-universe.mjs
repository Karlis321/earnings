#!/usr/bin/env node
/**
 * Universe-wide analyst-estimates ingest via Yahoo's v10 quoteSummary
 * `earningsTrend` module. Extends the covered-tier script
 * scripts/backfills/ingest-revenue-estimates.mjs to every operating
 * entity (~1,774 tickers).
 *
 * earningsTrend carries BOTH revenueEstimate + earningsEstimate at
 * near-term period keys 0q (current quarter) and +1q (next quarter).
 * We attach to upcoming events on the shard whose period matches.
 * Past events are NOT retroactively estimated here — a captured-in-
 * time analyst consensus can't be backdated. (Retroactive EPS
 * estimates from the earningsChart.quarterly path are handled by
 * scripts/ingest-eps-estimates.mjs — Yahoo keeps that history.)
 *
 *   node scripts/ingest-estimates-universe.mjs [--dry] [--limit=N]
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

const UA = "Mozilla/5.0 (ingest-estimates-universe)";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function periodFromEndDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `FY${y} Q${q}`;
}

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const setCookies = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of setCookies) {
    const f = raw.split(";", 1)[0].trim();
    const eq = f.indexOf("=");
    if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
  }
  COOKIE = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE },
  });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchEarningsTrend(symbol) {
  if (!CRUMB || !COOKIE) return { error: "no-crumb" };
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=earningsTrend&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return { trend: j?.quoteSummary?.result?.[0]?.earningsTrend?.trend ?? [] };
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
  console.log(`ingest-estimates-universe · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT} concurrency=${CONCURRENCY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const targets = (reg.entities ?? []).filter(
    (e) => e.securityType === "operating" && typeof e.yahooSymbol === "string" && e.yahooSymbol.length > 0,
  ).slice(0, LIMIT);
  console.log(`Targets: ${targets.length} operating entities with Yahoo symbols`);

  await primeCrumb();
  if (!CRUMB) { console.error("Yahoo crumb prime failed"); process.exit(1); }
  console.log(`crumb=${CRUMB.slice(0, 6)}…`);

  const nowIso = new Date().toISOString();
  const rollup = {
    schema: "ingest-estimates-universe/v1",
    generatedAt: nowIso,
    totals: {
      fetched: 0,
      fetchErrors: 0,
      empty: 0,
      shardsRead: 0,
      shardsWritten: 0,
      revenueAttached: 0,
      epsAttached: 0,
      quartersProcessed: 0,
      noMatchingUpcoming: 0,
    },
    perEntity: [],
  };

  let processed = 0;
  await pool(targets, CONCURRENCY, async (entity) => {
    processed++;
    const r = await fetchEarningsTrend(entity.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) {
      rollup.totals.fetchErrors++;
      rollup.perEntity.push({ ticker: entity.ticker, status: "fetch-error", detail: r.error });
      if (processed % 100 === 0) {
        console.log(`  ${processed}/${targets.length} · rev=${rollup.totals.revenueAttached} · eps=${rollup.totals.epsAttached} · shards=${rollup.totals.shardsWritten}`);
      }
      return;
    }
    const trend = r.trend ?? [];
    if (trend.length === 0) {
      rollup.totals.empty++;
      rollup.perEntity.push({ ticker: entity.ticker, status: "empty" });
      return;
    }

    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let shardRaw;
    try {
      shardRaw = JSON.parse(await fs.readFile(shardPath, "utf-8"));
      rollup.totals.shardsRead++;
    } catch {
      rollup.perEntity.push({ ticker: entity.ticker, status: "no-shard" });
      return;
    }
    const wrapped = !Array.isArray(shardRaw);
    const events = wrapped ? shardRaw.events ?? [] : shardRaw;
    const originalJson = JSON.stringify(events);

    const perEntity = { ticker: entity.ticker, rev: 0, eps: 0, quarters: 0 };

    for (const t of trend) {
      if (t.period !== "0q" && t.period !== "+1q") continue;
      const endDate = t.endDate;
      if (!endDate) continue;
      const targetPeriod = periodFromEndDate(endDate);
      const revEst = t.revenueEstimate ?? {};
      const epsEst = t.earningsEstimate ?? {};

      // Attach to upcoming (no eventDate) matching by period first;
      // fallback to any not-yet-reported event.
      const target = events.find((e) => e.period === targetPeriod && !e.eventDate);
      if (!target) { rollup.totals.noMatchingUpcoming++; continue; }
      rollup.totals.quartersProcessed++;
      perEntity.quarters++;

      if (!Array.isArray(target.metrics)) target.metrics = [];

      // Revenue estimate.
      const revAvg = revEst.avg?.raw;
      if (revAvg != null) {
        let m = target.metrics.find((x) => x.key === "revenue_usd_m");
        if (!m) {
          m = { key: "revenue_usd_m", displayLabel: "Revenue (M)", isHeadline: false, surprisePct: null, estimate: null, actual: null, prior: null };
          target.metrics.push(m);
        }
        if (!m.estimate || m.estimate.value == null) {
          m.estimate = {
            value: revAvg / 1_000_000,
            unit: entity.currency ?? "USD",
            source: {
              url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/analysis`,
              label: `Yahoo · earningsTrend (${revEst.numberOfAnalysts?.raw ?? "?"} analysts)`,
              provenance: "wire",
              locator: null,
            },
            asOf: endDate,
            fetchedAt: nowIso,
            method: "yahoo",
            confidence: 0.75,
          };
          m.estimate.low_usd_m = revEst.low?.raw != null ? revEst.low.raw / 1_000_000 : null;
          m.estimate.high_usd_m = revEst.high?.raw != null ? revEst.high.raw / 1_000_000 : null;
          m.estimate.numberOfAnalysts = revEst.numberOfAnalysts?.raw ?? null;
          perEntity.rev++;
          rollup.totals.revenueAttached++;
        }
      }

      // EPS estimate.
      const epsAvg = epsEst.avg?.raw;
      if (epsAvg != null) {
        let m = target.metrics.find((x) => x.key === "eps_usd");
        if (!m) {
          m = { key: "eps_usd", displayLabel: "EPS", isHeadline: entity.headlineMetrics?.includes("eps_usd") ?? false, surprisePct: null, estimate: null, actual: null, prior: null };
          target.metrics.push(m);
        }
        if (!m.estimate || m.estimate.value == null) {
          m.estimate = {
            value: epsAvg,
            unit: entity.currency ?? "USD",
            source: {
              url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/analysis`,
              label: `Yahoo · earningsTrend (${epsEst.numberOfAnalysts?.raw ?? "?"} analysts)`,
              provenance: "wire",
              locator: null,
            },
            asOf: endDate,
            fetchedAt: nowIso,
            method: "yahoo",
            confidence: 0.75,
          };
          m.estimate.low = epsEst.low?.raw ?? null;
          m.estimate.high = epsEst.high?.raw ?? null;
          m.estimate.numberOfAnalysts = epsEst.numberOfAnalysts?.raw ?? null;
          perEntity.eps++;
          rollup.totals.epsAttached++;
        }
      }
    }

    const nextJson = JSON.stringify(events);
    if (nextJson !== originalJson && !DRY) {
      const body = wrapped ? { ...shardRaw, events } : events;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
    rollup.perEntity.push({ ...perEntity, status: nextJson !== originalJson ? "written" : "unchanged" });

    if (processed % 100 === 0 || processed === targets.length) {
      console.log(`  ${processed}/${targets.length} · rev=${rollup.totals.revenueAttached} · eps=${rollup.totals.epsAttached} · shards=${rollup.totals.shardsWritten}`);
    }
  });

  console.log(`\n=== ingest-estimates-universe ===`);
  console.log(`Entities scanned:         ${processed}`);
  console.log(`Fetch errors:             ${rollup.totals.fetchErrors}`);
  console.log(`Empty trend:              ${rollup.totals.empty}`);
  console.log(`Shards written:           ${rollup.totals.shardsWritten}`);
  console.log(`Revenue estimates added:  ${rollup.totals.revenueAttached}`);
  console.log(`EPS estimates added:      ${rollup.totals.epsAttached}`);
  console.log(`No upcoming match:        ${rollup.totals.noMatchingUpcoming}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "ingest-estimates-universe.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/ingest-estimates-universe.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
