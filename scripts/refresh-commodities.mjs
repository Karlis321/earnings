#!/usr/bin/env node
/**
 * Phase 4.2 — commodity price snapshot for the /week-ahead
 * commodity strip. Fetches a fixed basket of Yahoo commodity
 * futures (6mo daily bars) and writes data/commodities.json.
 * Named "commodities" (not "EIA") because Yahoo covers the whole
 * basket in one hop — no separate EIA_API_KEY required. The
 * schema can absorb an EIA path later if we ever need weekly
 * inventory/production data.
 *
 *   node scripts/refresh-commodities.mjs [--dry]
 *
 * Basket rationale — matches the watchlist's exposure:
 *   CL=F crude WTI       — energy names (XEG CN, oil-services)
 *   BZ=F Brent           — international oil beta
 *   NG=F natural gas     — TOI CN gas
 *   GC=F gold            — GDXJ US, gold miners
 *   SI=F silver          — VLE CN, silver-miner beta
 *   HG=F copper          — TGB / HBM / CS / TNZ (copper cluster)
 *   PL=F platinum        — VLE CN
 *   ZC=F corn            — ag exposure (broader macro read)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "commodities.json");

const DRY = process.argv.includes("--dry");

const BASKET = [
  { symbol: "CL=F", label: "Crude WTI", unit: "USD/bbl", group: "energy" },
  { symbol: "BZ=F", label: "Brent", unit: "USD/bbl", group: "energy" },
  { symbol: "NG=F", label: "Nat gas", unit: "USD/MMBtu", group: "energy" },
  { symbol: "GC=F", label: "Gold", unit: "USD/oz", group: "precious" },
  { symbol: "SI=F", label: "Silver", unit: "USD/oz", group: "precious" },
  { symbol: "HG=F", label: "Copper", unit: "USD/lb", group: "base" },
  { symbol: "PL=F", label: "Platinum", unit: "USD/oz", group: "precious" },
  { symbol: "ZC=F", label: "Corn", unit: "USd/bu", group: "ag" },
];
const RANGE = "6mo";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Accept: "*/*" };

async function yahooBars(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=${RANGE}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("no result");
  const ts = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number" && c > 0) {
      bars.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close: Number(c.toFixed(4)),
      });
    }
  }
  // Append live regular-market price when it beats the latest bar
  // (identical logic to refresh-market-pulse).
  const rmt = result.meta?.regularMarketTime;
  const rmp = result.meta?.regularMarketPrice;
  if (typeof rmt === "number" && rmt > 0 && typeof rmp === "number" && rmp > 0) {
    const liveDate = new Date(rmt * 1000).toISOString().slice(0, 10);
    const lastBarDate = bars.length ? bars[bars.length - 1].date : "";
    if (liveDate > lastBarDate) {
      bars.push({ date: liveDate, close: Number(rmp.toFixed(4)) });
    }
  }
  return {
    bars,
    currency: result.meta?.currency ?? null,
    regularMarketPrice: result.meta?.regularMarketPrice ?? null,
  };
}

function pctChange(bars, days) {
  if (bars.length < days + 1) return null;
  const cur = bars[bars.length - 1].close;
  const ref = bars[bars.length - 1 - days].close;
  if (ref === 0) return null;
  return Number((((cur - ref) / ref) * 100).toFixed(2));
}

async function main() {
  console.log(`refresh-commodities · basket=${BASKET.length} · range=${RANGE} · dry=${DRY}`);

  const items = [];
  for (const spec of BASKET) {
    try {
      await new Promise((r) => setTimeout(r, 300));
      const { bars, currency } = await yahooBars(spec.symbol);
      const last = bars[bars.length - 1];
      const item = {
        symbol: spec.symbol,
        label: spec.label,
        unit: spec.unit,
        group: spec.group,
        currency,
        latest: last ? { date: last.date, close: last.close } : null,
        change1d: pctChange(bars, 1),
        change5d: pctChange(bars, 5),
        change30d: pctChange(bars, 21),
        change90d: pctChange(bars, 63),
        bars,
      };
      items.push(item);
      console.log(
        `  · ${spec.symbol.padEnd(6)} (${spec.label.padEnd(11)}) · ${bars.length} bars · last ${last?.date} @${last?.close} · 1d ${item.change1d ?? "—"}% · 30d ${item.change30d ?? "—"}%`,
      );
    } catch (e) {
      console.warn(`  · ${spec.symbol} · fetch failed: ${e.message}`);
      items.push({
        symbol: spec.symbol,
        label: spec.label,
        unit: spec.unit,
        group: spec.group,
        currency: null,
        latest: null,
        change1d: null,
        change5d: null,
        change30d: null,
        change90d: null,
        bars: [],
        error: e.message,
      });
    }
  }

  const out = {
    schema: "commodities/v1",
    generatedAt: new Date().toISOString(),
    range: RANGE,
    items,
  };

  if (DRY) {
    console.log("[dry] would write", OUT_PATH);
  } else {
    await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
    console.log(`✓ wrote data/commodities.json · ${items.length} commodities`);
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
