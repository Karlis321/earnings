#!/usr/bin/env node
/**
 * DEPRECATED (shard-first): reads + writes data/earnings.json (gitignored).
 * Retained for archival re-runs against a reconstituted monolith.
 *
 * Fix currency labels on timeseries-sourced metrics. My original
 * backfill hardcoded unit="USD" but Yahoo timeseries returns
 * currencyCode per data point — for .TO / .L / .DE issuers reporting
 * in CAD / GBP / EUR the stored unit was wrong.
 *
 * For each entity with timeseries-sourced metrics:
 *   1. Refetch timeseries (small query, just currency probe)
 *   2. Read currencyCode from any populated data point
 *   3. Update metric.actual.unit on ALL its timeseries-sourced metrics
 *
 * Also renames metric keys where appropriate: revenue_usd_m stays as
 * the key (so downstream code doesn't break) but unit reflects reality.
 *
 *   node scripts/fix-timeseries-currency.mjs
 *   node scripts/fix-timeseries-currency.mjs --dry
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
const CONCURRENCY = 6;
const UA = "Mozilla/5.0";

const TIMESERIES_SRC_LABEL = "Yahoo · fundamentals-timeseries";
const PRICE_KEYS = new Set(["eps_usd", "eps_diluted_usd"]); // per-share, not scaled

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
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

async function fetchCurrency(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 2 * 365 * 24 * 3600;
  const url =
    `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?type=quarterlyTotalRevenue&period1=${from}&period2=${now}&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const results = j.timeseries?.result ?? [];
    for (const rr of results) {
      const dk = Object.keys(rr).find((k) => k !== "meta" && k !== "timestamp");
      if (!dk) continue;
      const data = rr[dk] ?? [];
      for (const d of data) {
        if (d?.currencyCode) return d.currencyCode;
      }
    }
    return null;
  } catch {
    return null;
  }
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
  console.log(`fix-timeseries-currency · dry=${DRY}`);
  await primeCrumb();
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));
  const entityByTicker = new Map(reg.entities.map((e) => [e.ticker, e]));

  // Find every ticker with at least one timeseries-sourced metric
  const affectedTickers = new Set();
  for (const ev of snap.events) {
    for (const m of ev.metrics ?? []) {
      if (m.actual?.source?.label === TIMESERIES_SRC_LABEL) {
        affectedTickers.add(ev.ticker);
        break;
      }
    }
  }
  console.log(`Tickers with timeseries metrics: ${affectedTickers.size}`);

  const currencyByTicker = new Map();
  const targets = [...affectedTickers]
    .map((t) => entityByTicker.get(t))
    .filter((e) => e?.yahooSymbol);

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 100 === 0) {
      console.log(`  [${idx}/${targets.length}] probed · found ${currencyByTicker.size} currencies so far`);
    }
    const ccy = await fetchCurrency(entity.yahooSymbol);
    if (ccy) currencyByTicker.set(entity.ticker, ccy);
  });

  console.log(`\nCurrencies resolved: ${currencyByTicker.size}/${targets.length}`);
  const distribution = {};
  for (const [, ccy] of currencyByTicker) {
    distribution[ccy] = (distribution[ccy] ?? 0) + 1;
  }
  console.log("Distribution:");
  for (const [ccy, n] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ccy.padEnd(5)} ${n}`);
  }

  // Now walk every timeseries metric and relabel unit
  let relabeled = 0;
  let unchanged = 0;
  for (const ev of snap.events) {
    const ccy = currencyByTicker.get(ev.ticker);
    if (!ccy) continue;
    for (const m of ev.metrics ?? []) {
      if (m.actual?.source?.label !== TIMESERIES_SRC_LABEL) continue;
      const isPerShare = PRICE_KEYS.has(m.key);
      const newUnit = isPerShare ? ccy : ccy;
      if (m.actual.unit === newUnit) {
        unchanged++;
        continue;
      }
      m.actual.unit = newUnit;
      // Also update displayLabel to indicate the reporting currency
      // when it's not USD.
      if (ccy !== "USD" && !m.displayLabel?.includes(ccy)) {
        // Insert currency hint inside the (M) parens or append.
        m.displayLabel = m.displayLabel?.includes("(M)")
          ? m.displayLabel.replace("(M)", `(M ${ccy})`)
          : m.displayLabel;
      }
      relabeled++;
    }
  }

  console.log(`\nMetrics relabeled: ${relabeled}`);
  console.log(`Metrics unchanged: ${unchanged}`);

  if (DRY) { console.log("Dry run — no write."); return; }
  await fs.writeFile(EARNINGS, JSON.stringify(snap, null, 2));
  console.log(`✓ wrote ${EARNINGS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
