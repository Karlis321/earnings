#!/usr/bin/env node
/**
 * For every entity in the registry, verify that a price graph will
 * render on its /s/[ticker] page. The chart uses /api/prices which
 * (after the earlier fix) prefers entity.yahooSymbol from the
 * registry. So the audit chain is:
 *   1. Does the entity have a yahooSymbol? (no → dead chart)
 *   2. Does Yahoo v8 chart return ≥1 bar for that symbol?
 *      (no → dead chart, symbol was wrong or ticker delisted)
 *
 * Reports per-class counts + a full gap list to
 * scripts/audits/audit-price-graphs.json. Doesn't mutate anything —
 * follow-up scripts can fix the naming.
 *
 *   node scripts/audit-price-graphs.mjs [--limit=N]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;

const UA = "Mozilla/5.0 (audit-price-graphs)";
const CONCURRENCY = 10;
const REQUEST_TIMEOUT_MS = 12_000;

async function yahooBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}`, bars: 0 };
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    let bars = 0;
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] != null && closes[i] != null) bars++;
    }
    return { bars };
  } catch (e) {
    return { error: e.message ?? "network", bars: 0 };
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
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).slice(0, LIMIT);
  console.log(`Auditing ${entities.length} entities · concurrency=${CONCURRENCY}`);

  const rollup = {
    schema: "audit-price-graphs/v1",
    generatedAt: new Date().toISOString(),
    counts: {
      totalEntities: entities.length,
      hasYahooSymbol: 0,
      missingYahooSymbol: 0,
      graphOk: 0,
      graphEmpty: 0,
      graphError: 0,
    },
    countsByType: { operating: {}, developer: {}, etf: {} },
    gaps: {
      missingYahooSymbol: [],
      graphEmptyOrError: [],
    },
  };

  let processed = 0;
  await pool(entities, CONCURRENCY, async (entity) => {
    processed++;
    const type = entity.securityType ?? "operating";
    if (!rollup.countsByType[type]) rollup.countsByType[type] = {};
    rollup.countsByType[type].total = (rollup.countsByType[type].total ?? 0) + 1;

    if (!entity.yahooSymbol) {
      rollup.counts.missingYahooSymbol++;
      rollup.countsByType[type].missing = (rollup.countsByType[type].missing ?? 0) + 1;
      rollup.gaps.missingYahooSymbol.push({ ticker: entity.ticker, type, listing: entity.listing });
      return;
    }
    rollup.counts.hasYahooSymbol++;
    const r = await yahooBars(entity.yahooSymbol);
    if (r.error) {
      rollup.counts.graphError++;
      rollup.countsByType[type].err = (rollup.countsByType[type].err ?? 0) + 1;
      rollup.gaps.graphEmptyOrError.push({ ticker: entity.ticker, type, symbol: entity.yahooSymbol, error: r.error, bars: 0 });
    } else if (r.bars === 0) {
      rollup.counts.graphEmpty++;
      rollup.countsByType[type].empty = (rollup.countsByType[type].empty ?? 0) + 1;
      rollup.gaps.graphEmptyOrError.push({ ticker: entity.ticker, type, symbol: entity.yahooSymbol, error: "empty-series", bars: 0 });
    } else {
      rollup.counts.graphOk++;
      rollup.countsByType[type].ok = (rollup.countsByType[type].ok ?? 0) + 1;
    }

    if (processed % 100 === 0 || processed === entities.length) {
      console.log(`  ${processed}/${entities.length} · ok=${rollup.counts.graphOk} · empty=${rollup.counts.graphEmpty} · err=${rollup.counts.graphError}`);
    }
  });

  const total = rollup.counts.totalEntities;
  const pct = (n) => ((n / total) * 100).toFixed(1) + "%";
  console.log(`\n=== audit-price-graphs ===`);
  console.log(`Total entities:          ${total}`);
  console.log(`Has yahooSymbol:         ${rollup.counts.hasYahooSymbol.toString().padStart(5)} (${pct(rollup.counts.hasYahooSymbol)})`);
  console.log(`Missing yahooSymbol:     ${rollup.counts.missingYahooSymbol.toString().padStart(5)} (${pct(rollup.counts.missingYahooSymbol)})`);
  console.log(`Graph OK (≥1 bar):       ${rollup.counts.graphOk.toString().padStart(5)} (${pct(rollup.counts.graphOk)})`);
  console.log(`Graph empty:             ${rollup.counts.graphEmpty.toString().padStart(5)} (${pct(rollup.counts.graphEmpty)})`);
  console.log(`Graph error:             ${rollup.counts.graphError.toString().padStart(5)} (${pct(rollup.counts.graphError)})`);
  console.log("\nBy security type:");
  for (const [type, c] of Object.entries(rollup.countsByType)) {
    console.log(`  ${type.padEnd(10)} total=${c.total ?? 0} · ok=${c.ok ?? 0} · empty=${c.empty ?? 0} · err=${c.err ?? 0} · missing-symbol=${c.missing ?? 0}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "audit-price-graphs.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/audit-price-graphs.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
