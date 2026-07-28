#!/usr/bin/env node
/**
 * For every operating + developer entity, classify data-coverage state:
 *
 *   OK       — has past events + price bars + fundamentals
 *   PARTIAL  — some data, missing a category
 *   EMPTY    — no earnings, no bars, no fundamentals
 *
 * Answers WHY each entity fails per category:
 *   no-yahoo-symbol   — entity lacks yahooSymbol; can't fetch anything
 *   no-past-quarters  — Yahoo returned 0 EPS-quarters (foreign wrapper, or
 *                       issuer that doesn't report quarterly in Yahoo's index)
 *   thin-price-history— <5 bars in 1mo range
 *   no-fundamentals   — Yahoo `financialData.totalRevenue`/`ebitda` null
 *
 *   node scripts/screen-equity-coverage.mjs                # write CSV
 *   node scripts/screen-equity-coverage.mjs --portfolio    # portfolio only
 *   node scripts/screen-equity-coverage.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const EARNINGS = path.join(ROOT, "data", "earnings.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const PORTFOLIO_ONLY = args.get("portfolio") === true;
const DRY = args.get("dry") === true;
const CONCURRENCY = 6;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const setCookies =
    typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
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

async function probe(yahooSymbol) {
  await primeCrumb();
  const out = {
    reachable: false,
    epsQuarters: 0,
    revQuarters: 0,
    hasTtmRevenue: false,
    hasTtmEbitda: false,
    priceBars: 0,
    priceReachable: false,
  };
  try {
    const summaryUrl =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}` +
      `?modules=earnings,financialData&crumb=${encodeURIComponent(CRUMB)}`;
    const r = await fetch(summaryUrl, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const j = await r.json();
      const result = j.quoteSummary?.result?.[0];
      if (result) {
        out.reachable = true;
        const ec = result.earnings?.earningsChart?.quarterly ?? [];
        const fc = result.earnings?.financialsChart?.quarterly ?? [];
        out.epsQuarters = ec.length;
        out.revQuarters = fc.length;
        const fd = result.financialData ?? {};
        out.hasTtmRevenue = fd.totalRevenue?.raw != null;
        out.hasTtmEbitda = fd.ebitda?.raw != null;
      }
    }
  } catch { /* leave defaults */ }

  try {
    const chartUrl =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
      `?interval=1d&range=1mo`;
    const r = await fetch(chartUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const j = await r.json();
      const result = j.chart?.result?.[0];
      if (result) {
        out.priceReachable = true;
        const closes = result.indicators?.quote?.[0]?.close ?? [];
        out.priceBars = closes.filter((c) => c != null).length;
      }
    }
  } catch { /* leave defaults */ }

  return out;
}

function classify(entity, coverage) {
  const reasons = [];
  if (!entity.yahooSymbol) reasons.push("no-yahoo-symbol");
  if (coverage.epsQuarters === 0) reasons.push("no-past-quarters");
  if (coverage.priceBars < 5) reasons.push("thin-price-history");
  if (!coverage.hasTtmRevenue && !coverage.hasTtmEbitda) reasons.push("no-fundamentals");

  let state;
  if (reasons.length === 0) state = "OK";
  else if (reasons.length >= 3) state = "EMPTY";
  else state = "PARTIAL";
  return { state, reasons };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log(`screen-equity-coverage · portfolio_only=${PORTFOLIO_ONLY} dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS, "utf-8"));

  const eventTickers = new Set(snap.events.map((ev) => ev.ticker));
  const eventCountByTicker = new Map();
  for (const ev of snap.events) {
    eventCountByTicker.set(ev.ticker, (eventCountByTicker.get(ev.ticker) ?? 0) + 1);
  }

  const equities = reg.entities.filter(
    (e) => e.securityType === "operating" || e.securityType === "developer",
  );
  const targets = PORTFOLIO_ONLY ? equities.filter((e) => e.isCore) : equities;
  console.log(`Screening ${targets.length} equities...`);

  await primeCrumb();

  const rows = await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 50 === 0) {
      console.log(`  [${idx}/${targets.length}] probed`);
    }
    const coverage = entity.yahooSymbol
      ? await probe(entity.yahooSymbol)
      : {
          reachable: false,
          epsQuarters: 0,
          revQuarters: 0,
          hasTtmRevenue: false,
          hasTtmEbitda: false,
          priceBars: 0,
          priceReachable: false,
        };
    const { state, reasons } = classify(entity, coverage);
    return {
      ticker: entity.ticker,
      displayName: entity.displayName,
      securityType: entity.securityType,
      isCore: !!entity.isCore,
      yahooSymbol: entity.yahooSymbol ?? "",
      localEvents: eventCountByTicker.get(entity.ticker) ?? 0,
      ...coverage,
      state,
      reasons: reasons.join("|"),
    };
  });

  // Buckets
  const buckets = { OK: 0, PARTIAL: 0, EMPTY: 0 };
  const reasonCounts = {};
  for (const r of rows) {
    buckets[r.state]++;
    for (const reason of r.reasons.split("|").filter(Boolean)) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  console.log(`\nCoverage summary:`);
  console.log(`  OK      : ${buckets.OK}`);
  console.log(`  PARTIAL : ${buckets.PARTIAL}`);
  console.log(`  EMPTY   : ${buckets.EMPTY}`);
  console.log(`\nReason frequencies:`);
  for (const [r, n] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(22)} ${n}`);
  }

  // Portfolio breakdown
  const portfolio = rows.filter((r) => r.isCore);
  if (portfolio.length > 0) {
    console.log(`\n=== Portfolio (${portfolio.length}) ===`);
    console.log(
      `${"ticker".padEnd(12)}  ${"state".padEnd(8)}  ${"events".padStart(6)}  ${"eps-q".padStart(5)}  ${"rev-q".padStart(5)}  ${"bars".padStart(4)}  ttm  reasons`,
    );
    for (const r of portfolio.sort((a, b) => a.ticker.localeCompare(b.ticker))) {
      const ttm = (r.hasTtmRevenue ? "R" : "-") + (r.hasTtmEbitda ? "E" : "-");
      console.log(
        `${r.ticker.padEnd(12)}  ${r.state.padEnd(8)}  ${String(r.localEvents).padStart(6)}  ${String(r.epsQuarters).padStart(5)}  ${String(r.revQuarters).padStart(5)}  ${String(r.priceBars).padStart(4)}  ${ttm}  ${r.reasons || ""}`,
      );
    }
  }

  if (DRY) return;
  const csv = [
    "ticker,displayName,securityType,isCore,yahooSymbol,localEvents,reachable,epsQuarters,revQuarters,hasTtmRevenue,hasTtmEbitda,priceBars,priceReachable,state,reasons",
    ...rows.map((r) =>
      [
        r.ticker,
        `"${r.displayName.replace(/"/g, '""')}"`,
        r.securityType,
        r.isCore,
        r.yahooSymbol,
        r.localEvents,
        r.reachable,
        r.epsQuarters,
        r.revQuarters,
        r.hasTtmRevenue,
        r.hasTtmEbitda,
        r.priceBars,
        r.priceReachable,
        r.state,
        r.reasons,
      ].join(","),
    ),
  ].join("\n");
  const out = path.join(ROOT, "data", "coverage-audit.csv");
  await fs.writeFile(out, csv);
  console.log(`\n✓ wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
