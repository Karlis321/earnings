#!/usr/bin/env node
/**
 * Refresh the 4 Market Pulse index series (^GSPC, ^NDX, ^STOXX50E,
 * ^VIX) via Yahoo v8/chart, ranges 1mo/1y/5y, and commit the result
 * to data/market-pulse.json. The overview page reads this snapshot
 * so the chart paints instantly from the deploy — no per-visitor
 * Yahoo call. The live client-side fetch stays as a fallback for
 * users who load between refreshes and want the intra-day tick.
 *
 * Live-price append: after the daily-bar walk, if
 * meta.regularMarketPrice + regularMarketTime carry a value later
 * than the last completed daily bar, add it as a synthetic latest
 * bar. Matches the yahooSeries() logic in frontend/server/vendors.
 *
 *   node scripts/refresh-market-pulse.mjs [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "market-pulse.json");

const DRY = process.argv.includes("--dry");

const INDICES = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^NDX", label: "Nasdaq 100" },
  { symbol: "^STOXX50E", label: "Euro Stoxx 50" },
  { symbol: "^VIX", label: "VIX" },
];
const RANGES = ["1mo", "1y", "5y"];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Accept: "*/*" };

async function yahooSeries(symbol, range) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("no result");
  const ts = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number") {
      out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
    }
  }
  const rmt = result.meta?.regularMarketTime;
  const rmp = result.meta?.regularMarketPrice;
  if (typeof rmt === "number" && rmt > 0 && typeof rmp === "number" && rmp > 0) {
    const liveDate = new Date(rmt * 1000).toISOString().slice(0, 10);
    const lastBarDate = out.length > 0 ? out[out.length - 1].date : "";
    if (liveDate > lastBarDate) out.push({ date: liveDate, close: rmp });
  }
  return {
    series: out,
    meta: {
      regularMarketPrice: result.meta?.regularMarketPrice ?? null,
      regularMarketTime: result.meta?.regularMarketTime
        ? new Date(result.meta.regularMarketTime * 1000).toISOString()
        : null,
      currency: result.meta?.currency ?? null,
      exchangeTimezoneName: result.meta?.exchangeTimezoneName ?? null,
    },
  };
}

async function main() {
  console.log(`refresh-market-pulse · dry=${DRY} · ${INDICES.length} indices × ${RANGES.length} ranges`);
  const snapshot = {
    schema: "market-pulse/v1",
    fetchedAt: new Date().toISOString(),
    indices: {},
  };
  let ok = 0;
  let err = 0;
  for (const idx of INDICES) {
    snapshot.indices[idx.symbol] = { label: idx.label, ranges: {} };
    for (const range of RANGES) {
      try {
        // 1 req/s to Yahoo — gentle.
        await new Promise((r) => setTimeout(r, 300));
        const data = await yahooSeries(idx.symbol, range);
        snapshot.indices[idx.symbol].ranges[range] = data;
        ok++;
        const last = data.series[data.series.length - 1];
        console.log(
          `  ${idx.symbol.padEnd(10)} · ${range} · ${data.series.length} bars · last ${last?.date} @${last?.close?.toFixed(2)}`,
        );
      } catch (e) {
        err++;
        console.error(`  ${idx.symbol} · ${range} · FAIL · ${e.message}`);
        snapshot.indices[idx.symbol].ranges[range] = { series: [], meta: null, error: e.message };
      }
    }
  }
  if (!DRY) {
    await fs.writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`  ✓ wrote ${OUT_PATH}`);
  }
  console.log(`\n=== refresh-market-pulse ===`);
  console.log(`  Fetches ok:   ${ok}`);
  console.log(`  Fetches err:  ${err}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
