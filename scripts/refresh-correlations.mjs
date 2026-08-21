#!/usr/bin/env node
/**
 * Phase 4.1 — pairwise return correlation snapshot over the
 * watchlist universe. Reads data/shared-state.json → watchlist,
 * resolves each ticker's yahooSymbol via the entity registry,
 * pulls 6mo of daily bars from Yahoo, computes daily log returns,
 * and writes a Pearson correlation matrix to
 * data/correlations.json. The /correlation page renders this as a
 * heatmap; no per-visitor Yahoo call.
 *
 *   node scripts/refresh-correlations.mjs [--dry] [--range=6mo]
 *
 * Design notes:
 *   - Symmetric matrix; only the upper triangle is meaningful but
 *     both halves are stored so the UI doesn't need to reflect.
 *   - Missing overlap between two series (different trading
 *     calendars) drops both sides and correlates on the intersection.
 *     Series with < 40 shared bars produce null instead of noise.
 *   - Rate-limit gentle (300ms between Yahoo calls) — 17 tickers ≈ 5s.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "correlations.json");
const STATE_PATH = path.join(ROOT, "data", "shared-state.json");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const DRY = process.argv.includes("--dry");
const RANGE_ARG = process.argv.find((a) => a.startsWith("--range="));
const RANGE = RANGE_ARG ? RANGE_ARG.slice("--range=".length) : "6mo";
const MIN_SHARED_BARS = 40;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Accept: "*/*" };

// Widening ladder — some low-volume foreign listings (ABXX.NE on
// Canada's NEO, .JK small-caps, etc.) return 1-2 bars at every range
// narrower than 'max' from server-side IPs (Yahoo throttles by
// origin). If the requested range doesn't clear MIN_SHARED_BARS,
// walk up to the next step and take whichever first gives us
// enough returns to correlate against a peer. Matches the same
// ladder used by /api/prices for the ticker chart.
const LADDER = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

async function fetchOne(symbol, range) {
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
  const bars = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number" && c > 0) {
      bars.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c);
    }
  }
  return bars;
}

async function yahooBars(symbol, range) {
  let bars = await fetchOne(symbol, range);
  if (bars.size >= MIN_SHARED_BARS) return { bars, widenedTo: null };
  const startIdx = LADDER.indexOf(range);
  if (startIdx < 0) return { bars, widenedTo: null };
  for (let i = startIdx + 1; i < LADDER.length; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const retry = await fetchOne(symbol, LADDER[i]);
    if (retry.size > bars.size) {
      bars = retry;
      if (bars.size >= MIN_SHARED_BARS) {
        return { bars, widenedTo: LADDER[i] };
      }
    }
  }
  return { bars, widenedTo: LADDER[LADDER.length - 1] };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < MIN_SHARED_BARS) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return null;
  return num / denom;
}

async function main() {
  console.log(
    `refresh-correlations · range=${RANGE} · dry=${DRY} · min shared bars=${MIN_SHARED_BARS}`,
  );

  const state = JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));
  const registry = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf-8"));
  const entities = Array.isArray(registry) ? registry : registry.entities;
  const byTicker = new Map(entities.map((e) => [e.ticker, e]));

  const universe = state.watchlist ?? [];
  if (universe.length < 2) {
    console.error("::error::watchlist has < 2 tickers — nothing to correlate");
    process.exit(1);
  }

  // Fetch bars per ticker
  const barsByTicker = new Map();
  for (const ticker of universe) {
    const ent = byTicker.get(ticker);
    if (!ent) {
      console.warn(`  · skip ${ticker} — not in registry`);
      continue;
    }
    const symbol = ent.yahooSymbol;
    if (!symbol) {
      console.warn(`  · skip ${ticker} — no yahooSymbol`);
      continue;
    }
    try {
      await new Promise((r) => setTimeout(r, 300));
      const { bars, widenedTo } = await yahooBars(symbol, RANGE);
      barsByTicker.set(ticker, bars);
      console.log(
        `  · ${ticker.padEnd(10)} (${symbol.padEnd(10)}) · ${bars.size} bars${widenedTo ? ` (widened ${RANGE}→${widenedTo})` : ""}`,
      );
    } catch (e) {
      console.warn(`  · ${ticker} · fetch failed: ${e.message}`);
    }
  }

  const tickers = [...barsByTicker.keys()];
  console.log(`fetched ${tickers.length}/${universe.length} tickers`);

  // Build per-ticker return series keyed by date (log return).
  const returnsByTicker = new Map();
  for (const ticker of tickers) {
    const bars = barsByTicker.get(ticker);
    const dates = [...bars.keys()].sort();
    const rets = new Map();
    for (let i = 1; i < dates.length; i++) {
      const prev = bars.get(dates[i - 1]);
      const cur = bars.get(dates[i]);
      if (prev > 0 && cur > 0) {
        rets.set(dates[i], Math.log(cur / prev));
      }
    }
    returnsByTicker.set(ticker, rets);
  }

  // Pairwise correlation via date-intersection.
  const matrix = {};
  for (const t of tickers) matrix[t] = {};
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i; j < tickers.length; j++) {
      const a = tickers[i];
      const b = tickers[j];
      if (a === b) {
        matrix[a][b] = 1;
        continue;
      }
      const ra = returnsByTicker.get(a);
      const rb = returnsByTicker.get(b);
      const shared = [];
      const xs = [];
      const ys = [];
      for (const [date, v] of ra) {
        const w = rb.get(date);
        if (typeof w === "number") {
          shared.push(date);
          xs.push(v);
          ys.push(w);
        }
      }
      const r = pearson(xs, ys);
      matrix[a][b] = r === null ? null : Number(r.toFixed(3));
      matrix[b][a] = matrix[a][b];
    }
  }

  const out = {
    schema: "correlations/v1",
    generatedAt: new Date().toISOString(),
    range: RANGE,
    minSharedBars: MIN_SHARED_BARS,
    tickers,
    matrix,
  };

  if (DRY) {
    console.log("[dry] would write", OUT_PATH);
    console.log(JSON.stringify(out, null, 2).slice(0, 600) + " …");
  } else {
    await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
    console.log(`✓ wrote data/correlations.json · ${tickers.length}² matrix`);
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
