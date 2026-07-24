#!/usr/bin/env node
/**
 * W8 backfill script — seeds data/prices/<yahoo-symbol>.json with historical
 * daily closes for every ticker in the entity registry.
 *
 * Run locally (from your machine, not Vercel — Yahoo occasionally rate-limits
 * datacenter IPs on longer-range queries).
 *
 *   node scripts/backfill.mjs                # default 3y range
 *   node scripts/backfill.mjs --range=5y     # or 1y / 2y / 5y / 10y / max
 *
 * The script:
 *   1. Reads frontend/lib/fixtures/registry.ts to enumerate tickers.
 *   2. Resolves each Bloomberg-style ticker → Yahoo symbol via query2 search.
 *   3. Fetches the price series via query1 chart.
 *   4. Writes one JSON file per ticker into data/prices/.
 *   5. Prints a per-ticker summary at the end.
 *
 * Commit the resulting data/prices/*.json files to git. The daily cron can
 * later refresh individual tickers by re-running with --ticker=<T>.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "prices");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const RANGE = args.get("range") || "3y";
const ONLY = args.get("ticker") || null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const EXCHANGE_MAP = {
  US: ["NMS", "NYQ", "ASE", "NGM", "NCM", "PCX", "NYS"],
  CN: ["TOR", "VAN", "CVE", "NEO"],
  FP: ["PAR"],
  FH: ["HEL"],
};

async function yahooResolve(bbTicker) {
  const [sym, exch = "US"] = bbTicker.split(/\s+/);
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=10&newsCount=0`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Yahoo search ${sym} → ${r.status}`);
  const j = await r.json();
  const acceptable = EXCHANGE_MAP[exch.toUpperCase()] ?? [];
  const match =
    j.quotes.find(
      (q) =>
        q.quoteType === "EQUITY" &&
        (acceptable.includes(q.exchange) || acceptable.length === 0) &&
        (q.symbol === sym || q.symbol.split(".")[0] === sym),
    ) || j.quotes.find((q) => q.quoteType === "EQUITY");
  if (!match) throw new Error(`No Yahoo equity for ${bbTicker}`);
  return { yahooSymbol: match.symbol, name: match.longname ?? match.shortname };
}

async function yahooSeries(symbol, range = RANGE) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Yahoo chart ${symbol} → ${r.status}`);
  const j = await r.json();
  const result = j.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart ${symbol} empty`);
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (typeof closes[i] === "number") {
      series.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close: closes[i],
      });
    }
  }
  return series;
}

// Simple TS parser via regex — we only need the ticker strings from
// frontend/lib/fixtures/registry.ts. Not a general-purpose TS parser.
async function loadTickers() {
  const registryPath = path.join(
    ROOT,
    "frontend",
    "lib",
    "fixtures",
    "registry.ts",
  );
  const src = await fs.readFile(registryPath, "utf8");
  const tickers = [];
  const re = /ticker:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) tickers.push(m[1]);
  return [...new Set(tickers)];
}

async function main() {
  console.log(`Backfill range=${RANGE}${ONLY ? ` ticker=${ONLY}` : ""}`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  const tickers = ONLY ? [ONLY] : await loadTickers();
  const summary = [];
  for (const t of tickers) {
    try {
      const { yahooSymbol, name } = await yahooResolve(t);
      const series = await yahooSeries(yahooSymbol, RANGE);
      const file = path.join(
        OUT_DIR,
        `${t.replace(/\s+/g, "_")}.json`,
      );
      const payload = {
        bloombergTicker: t,
        yahooSymbol,
        name,
        range: RANGE,
        fetchedAt: new Date().toISOString(),
        series,
      };
      await fs.writeFile(file, JSON.stringify(payload, null, 2));
      summary.push({ t, yahooSymbol, days: series.length, ok: true });
      console.log(`  ✓ ${t} → ${yahooSymbol} · ${series.length} days`);
      // Be nice to Yahoo — 250ms between calls.
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      summary.push({ t, err: e.message, ok: false });
      console.error(`  ✗ ${t} — ${e.message}`);
    }
  }
  console.log(`\nDone. ${summary.filter((s) => s.ok).length}/${summary.length} succeeded.`);
  const failures = summary.filter((s) => !s.ok);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(`  ${f.t}: ${f.err}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
