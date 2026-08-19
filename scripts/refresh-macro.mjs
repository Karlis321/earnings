#!/usr/bin/env node
/**
 * Feature 2C — macro extremity phase.
 *
 * Fetches a curated set of market-priced macro series from Yahoo v8
 * (same endpoint we already use for MarketPulse), computes the
 * latest observation's z-score against its rolling 3-year window,
 * and writes data/macro-signals.json with `flag: "extreme"` on any
 * series where |z| > 2.
 *
 * Yahoo over FRED/DBnomics: keyless, already-vetted vendor with
 * existing rate-limit handling, and the market-priced signals
 * (VIX, DXY, oil, yields) are what actually move ahead of the
 * pure-economic prints anyway. Downside: no unemployment / CPI /
 * industrial production. Trade-off accepted — those series update
 * monthly and lag the market signals by 4-6 weeks anyway.
 *
 * Usage:
 *   node scripts/refresh-macro.mjs
 *   node scripts/refresh-macro.mjs --verbose
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "macro-signals.json");

const VERBOSE = process.argv.includes("--verbose");

// Curated market-priced macro series. Each has a `key` we render on
// the UI, a `symbol` fetched from Yahoo, and an `interpretation`
// that appears in the UI tooltip so a reader knows what a +2σ
// reading is telling them.
const SERIES = [
  {
    key: "VIX",
    symbol: "^VIX",
    label: "VIX (S&P vol)",
    unit: "index",
    interpretation: "High z = equity stress event vs recent calm",
  },
  {
    key: "IEF",
    symbol: "IEF",
    label: "7-10y Treasury ETF (price)",
    unit: "price",
    interpretation:
      "Low z (falling price) = long yields elevated vs 3y history — bond bear market signal",
  },
  {
    key: "SHY",
    symbol: "SHY",
    label: "1-3y Treasury ETF (price)",
    unit: "price",
    interpretation:
      "Low z = front-end yields elevated (Fed pricing hikes); tracks 2y+3y",
  },
  {
    key: "TLT",
    symbol: "TLT",
    label: "20y+ Treasury ETF (price)",
    unit: "price",
    interpretation:
      "Long-duration barometer — extreme z either direction is a term-premium event",
  },
  {
    key: "DXY",
    symbol: "DX-Y.NYB",
    label: "US Dollar Index",
    unit: "index",
    interpretation:
      "High z = USD strength vs G10 — headwind for foreign earnings",
  },
  {
    key: "WTI",
    symbol: "CL=F",
    label: "WTI crude",
    unit: "$/bbl",
    interpretation: "Extreme moves signal supply shocks or demand collapse",
  },
  {
    key: "GOLD",
    symbol: "GC=F",
    label: "Gold",
    unit: "$/oz",
    interpretation:
      "High z = flight-to-safety bid or real-rate collapse — both risk-off signals",
  },
  {
    key: "SPX",
    symbol: "^GSPC",
    label: "S&P 500",
    unit: "index",
    interpretation:
      "Level series — extreme downside z aligns with corrections; upside with mania",
  },
  {
    key: "NDX",
    symbol: "^NDX",
    label: "Nasdaq 100",
    unit: "index",
    interpretation:
      "Tech-heavy risk barometer — diverges from SPX in rate-driven rotations",
  },
  {
    key: "HYG",
    symbol: "HYG",
    label: "High-yield credit ETF",
    unit: "price",
    interpretation:
      "Low z = credit spreads widening — first sign risk-off migrates from equities to bonds",
  },
];

const UA =
  "Mozilla/5.0 (compatible; earnings-dashboard/1.0; +contact@example.com)";

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=5y&interval=1wk`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("no result");
  const ts = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const pairs = [];
  for (let i = 0; i < Math.min(ts.length, closes.length); i++) {
    const v = closes[i];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    pairs.push({ date, value: v });
  }
  return pairs;
}

// z-score of the latest observation against the trailing 3-year
// window (up to but excluding the latest observation).
function zScore(pairs) {
  if (pairs.length < 26) return null; // need at least ~6 months weekly
  const latest = pairs[pairs.length - 1];
  const cutoff = new Date(latest.date);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const window = pairs.slice(0, -1).filter((p) => p.date >= cutoffIso);
  if (window.length < 26) return null;
  const n = window.length;
  const mean = window.reduce((s, p) => s + p.value, 0) / n;
  const variance =
    window.reduce((s, p) => s + Math.pow(p.value - mean, 2), 0) / n;
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return null;
  return {
    latest: latest.value,
    latestDate: latest.date,
    windowN: n,
    mean,
    stdev,
    z: (latest.value - mean) / stdev,
  };
}

async function main() {
  const results = [];
  const errors = [];
  for (const s of SERIES) {
    try {
      const pairs = await fetchBars(s.symbol);
      const stats = zScore(pairs);
      if (!stats) {
        errors.push(`${s.key}: insufficient history (${pairs.length} pts)`);
        continue;
      }
      const mult = s.valueMultiplier ?? 1;
      const latestScaled = stats.latest * mult;
      const flag =
        Math.abs(stats.z) > 2
          ? "extreme"
          : Math.abs(stats.z) > 1
          ? "elevated"
          : "normal";
      results.push({
        key: s.key,
        symbol: s.symbol,
        label: s.label,
        unit: s.unit,
        interpretation: s.interpretation,
        latest: Number(latestScaled.toFixed(4)),
        latestDate: stats.latestDate,
        window: {
          years: 3,
          observations: stats.windowN,
          mean: Number((stats.mean * mult).toFixed(4)),
          stdev: Number((stats.stdev * mult).toFixed(4)),
        },
        zScore: Number(stats.z.toFixed(3)),
        flag,
      });
      if (VERBOSE) {
        console.log(
          `  ${s.key.padEnd(6)}  ${latestScaled.toFixed(2).padStart(9)}  ` +
            `z=${stats.z.toFixed(2).padStart(6)}  [${flag}]  ${s.label}`,
        );
      }
    } catch (e) {
      errors.push(`${s.key}: ${e.message}`);
    }
    // Gentle throttle — Yahoo v8 tolerates parallel bursts but this
    // is a background phase, no need to hammer.
    await new Promise((r) => setTimeout(r, 120));
  }

  const out = {
    schema: "macro-signals/v1",
    generatedAt: new Date().toISOString(),
    windowYears: 3,
    thresholds: { elevated: 1, extreme: 2 },
    signals: results,
    errors: errors.length > 0 ? errors : undefined,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  const extreme = results.filter((r) => r.flag === "extreme").length;
  const elevated = results.filter((r) => r.flag === "elevated").length;
  console.log(
    `✓ wrote data/macro-signals.json · ${results.length} series · ` +
      `${extreme} extreme · ${elevated} elevated · ${errors.length} errors`,
  );
  if (errors.length > 0 && !VERBOSE) {
    for (const e of errors) console.log(`  ${e}`);
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
