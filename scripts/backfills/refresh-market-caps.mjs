#!/usr/bin/env node
/**
 * Mirror cron step 6b: for every entity, pull marketCap in home currency
 * from Yahoo v7 quote (crumb-authed) and convert to USD using live
 * `<CCY>USD=X` rates. Re-tier and write back to entity-registry.json.
 *
 * Fixes ARS/KRW/IDR/JPY tickers whose caps came in inflated because
 * expand-sectors.mjs used the fallback FX table which under-estimates
 * ARS depreciation and other fast-moving pairs.
 *
 *   node scripts/refresh-market-caps.mjs        # write
 *   node scripts/refresh-market-caps.mjs --dry  # report only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const FX_FALLBACK = {
  USD: 1,
  EUR: 1.14, GBP: 1.33, JPY: 0.0067, CHF: 1.12, CAD: 0.71, AUD: 0.70, NZD: 0.58,
  SEK: 0.096, NOK: 0.093, DKK: 0.144, ISK: 0.008,
  PLN: 0.26, CZK: 0.047, HUF: 0.0032, RON: 0.22, TRY: 0.021,
  HKD: 0.128, SGD: 0.75, CNY: 0.148, KRW: 0.00068, TWD: 0.031, INR: 0.012,
  IDR: 0.000056, THB: 0.030, MYR: 0.245, PHP: 0.016,
  ILS: 0.33, AED: 0.272, SAR: 0.266, QAR: 0.275,
  ZAR: 0.060,
  BRL: 0.197, MXN: 0.055, CLP: 0.00105, COP: 0.00031, PEN: 0.295, ARS: 0.00067,
};

let CRUMB = null;
let COOKIE_HEADER = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA, Accept: "text/html" },
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
  COOKIE_HEADER = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE_HEADER) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
  });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchLiveFxRates() {
  await primeCrumb();
  const symbols = Object.keys(FX_FALLBACK)
    .filter((c) => c !== "USD")
    .map((c) => `${c}USD=X`);
  const rates = { USD: 1 };
  try {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote" +
      `?symbols=${encodeURIComponent(symbols.join(","))}&crumb=${encodeURIComponent(CRUMB)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const j = await r.json();
    for (const q of j.quoteResponse?.result ?? []) {
      const ccy = (q.symbol ?? "").replace(/USD=X$/, "");
      if (typeof q.regularMarketPrice === "number" && q.regularMarketPrice > 0) {
        rates[ccy] = q.regularMarketPrice;
      }
    }
  } catch {
    /* fall through — merged with fallback below */
  }
  return { ...FX_FALLBACK, ...rates };
}

function toUsd(mc, ccy, rates) {
  if (mc == null || Number.isNaN(mc)) return null;
  const rate = rates[ccy] ?? FX_FALLBACK[ccy] ?? null;
  if (rate == null) return null;
  return Math.round(mc * rate);
}

function capTierFor(mc) {
  if (mc == null || Number.isNaN(mc)) return "unknown";
  if (mc >= 200_000_000_000) return "mega";
  if (mc >= 10_000_000_000) return "large";
  if (mc >= 2_000_000_000) return "mid";
  if (mc >= 250_000_000) return "small";
  return "unknown";
}

async function fetchQuotes(symbols) {
  const rows = new Map();
  const batchSize = 80;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote" +
      `?symbols=${encodeURIComponent(batch.join(","))}&crumb=${encodeURIComponent(CRUMB)}`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
      });
      if (!r.ok) continue;
      const j = await r.json();
      for (const q of j.quoteResponse?.result ?? []) {
        // ETF fallback: netAssets when marketCap missing
        const mc =
          q.marketCap ?? q.netAssets ?? q.totalAssets ?? null;
        rows.set(q.symbol, {
          marketCap: mc,
          currency: q.currency ?? null,
        });
      }
    } catch {
      /* skip batch */
    }
  }
  return rows;
}

async function main() {
  console.log(`refresh-market-caps · dry=${DRY}`);
  const raw = await fs.readFile(REGISTRY_PATH, "utf-8");
  const registry = JSON.parse(raw);

  const rates = await fetchLiveFxRates();
  const liveCcys = Object.keys(rates).filter(
    (c) => c !== "USD" && rates[c] !== FX_FALLBACK[c],
  );
  console.log(
    `Live FX: ${liveCcys.length}/${Object.keys(FX_FALLBACK).length - 1} currencies`,
  );
  if (liveCcys.includes("ARS")) {
    console.log(`  ARS/USD: fallback=${FX_FALLBACK.ARS} · live=${rates.ARS}`);
  }
  if (liveCcys.includes("KRW")) {
    console.log(`  KRW/USD: fallback=${FX_FALLBACK.KRW} · live=${rates.KRW}`);
  }

  const symbols = registry.entities
    .map((e) => e.yahooSymbol)
    .filter(Boolean);
  console.log(`Fetching quotes for ${symbols.length} symbols…`);
  const quotes = await fetchQuotes(symbols);
  console.log(`Got quotes for ${quotes.size}/${symbols.length} symbols`);

  const tierMoves = [];
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  const asOf = new Date().toISOString().slice(0, 10);

  for (const entity of registry.entities) {
    const q = entity.yahooSymbol ? quotes.get(entity.yahooSymbol) : null;
    if (!q || q.marketCap == null) {
      failed++;
      continue;
    }
    const newUsd = toUsd(q.marketCap, q.currency ?? entity.currency ?? "USD", rates);
    if (newUsd == null) {
      failed++;
      continue;
    }
    const newTier = capTierFor(newUsd);
    const priorTier = entity.capTier ?? "unknown";
    if (entity.marketCapUsd === newUsd && priorTier === newTier) {
      unchanged++;
      continue;
    }
    if (priorTier !== newTier) {
      tierMoves.push({
        ticker: entity.ticker,
        priorTier,
        newTier,
        priorMc: entity.marketCapUsd,
        newMc: newUsd,
      });
    }
    entity.marketCapUsd = newUsd;
    entity.marketCapAsOf = asOf;
    entity.capTier = newTier;
    updated++;
  }

  console.log(`\nUpdated: ${updated} · unchanged: ${unchanged} · failed: ${failed}`);
  console.log(`\nTier moves (${tierMoves.length}):`);
  for (const m of tierMoves.slice(0, 20)) {
    const priorMc = m.priorMc ? `$${(m.priorMc / 1e9).toFixed(1)}B` : "—";
    const newMc = m.newMc ? `$${(m.newMc / 1e9).toFixed(1)}B` : "—";
    console.log(
      `  ${m.ticker.padEnd(14)} ${m.priorTier.padEnd(7)} → ${m.newTier.padEnd(7)}  ${priorMc.padStart(10)} → ${newMc}`,
    );
  }
  if (tierMoves.length > 20) console.log(`  … +${tierMoves.length - 20} more`);

  if (DRY) {
    console.log("\nDry run — no write.");
    return;
  }
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`\n✓ wrote ${REGISTRY_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
