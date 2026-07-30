#!/usr/bin/env node
/**
 * Hit the DEPLOYED /api/prices?ticker=<BB>&range=1mo for every
 * operating entity in the registry. Report:
 *   - bars returned after widening
 *   - who got widened (widenedFrom present)
 *   - who still returns <5 bars (still broken → needs different fix)
 *   - who returns 0 bars (dead — delisted, wrong symbol, or Yahoo drop)
 *
 * Verifies the ABXX CN fix (widening 1mo → max) actually resolves the
 * "No price data" problem for every foreign small-cap with the same
 * pattern, not just ABXX.
 *
 *   node scripts/audit-deployed-prices.mjs [--limit=N]
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

const BASE = "https://earnings-karlis123.vercel.app";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;

async function apiPrice(ticker) {
  const url = `${BASE}/api/prices?ticker=${encodeURIComponent(ticker)}&range=1mo`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!r.ok) return { status: r.status, bars: 0, widened: null };
    const j = await r.json();
    return {
      status: 200,
      bars: j.series?.length ?? 0,
      widened: j.widenedFrom ?? null,
      finalRange: j.range ?? "1mo",
    };
  } catch (e) {
    return { status: 0, error: e.message ?? "network", bars: 0, widened: null };
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
  const targets = (reg.entities ?? [])
    .filter((e) => e.securityType === "operating")
    .slice(0, LIMIT);
  console.log(`Auditing ${targets.length} operating entities · concurrency=${CONCURRENCY}`);

  const rollup = {
    schema: "audit-deployed-prices/v1",
    generatedAt: new Date().toISOString(),
    counts: {
      total: targets.length,
      okThick: 0,        // ≥5 bars, no widening needed
      okWidened: 0,      // ≥5 bars, widening resolved
      thinAfterWidening: 0, // 1-4 bars even after widening
      empty: 0,          // 0 bars
      errored: 0,        // fetch failed
    },
    byWidenedFrom: {},
    stillBroken: [],
    exampleWidened: [],
  };

  let processed = 0;
  await pool(targets, CONCURRENCY, async (entity) => {
    processed++;
    const r = await apiPrice(entity.ticker);
    if (r.status === 0) {
      rollup.counts.errored++;
      rollup.stillBroken.push({ ticker: entity.ticker, symbol: entity.yahooSymbol, bars: 0, error: r.error });
    } else if (r.bars === 0) {
      rollup.counts.empty++;
      rollup.stillBroken.push({ ticker: entity.ticker, symbol: entity.yahooSymbol, bars: 0 });
    } else if (r.bars < 5) {
      rollup.counts.thinAfterWidening++;
      rollup.stillBroken.push({
        ticker: entity.ticker, symbol: entity.yahooSymbol, bars: r.bars, widened: r.widened,
      });
    } else if (r.widened) {
      rollup.counts.okWidened++;
      rollup.byWidenedFrom[r.widened] = (rollup.byWidenedFrom[r.widened] ?? 0) + 1;
      if (rollup.exampleWidened.length < 20) {
        rollup.exampleWidened.push({
          ticker: entity.ticker, symbol: entity.yahooSymbol, bars: r.bars,
          widenedFrom: r.widened, finalRange: r.finalRange,
        });
      }
    } else {
      rollup.counts.okThick++;
    }

    if (processed % 100 === 0 || processed === targets.length) {
      console.log(`  ${processed}/${targets.length} · thick=${rollup.counts.okThick} · widened=${rollup.counts.okWidened} · thin=${rollup.counts.thinAfterWidening} · empty=${rollup.counts.empty} · err=${rollup.counts.errored}`);
    }
  });

  console.log(`\n=== audit-deployed-prices ===`);
  const pct = (n) => ((n / targets.length) * 100).toFixed(1) + "%";
  console.log(`Total:                  ${targets.length}`);
  console.log(`OK — 1mo thick:         ${rollup.counts.okThick.toString().padStart(5)} (${pct(rollup.counts.okThick)})`);
  console.log(`OK — widening resolved: ${rollup.counts.okWidened.toString().padStart(5)} (${pct(rollup.counts.okWidened)})`);
  console.log(`Thin after widening:    ${rollup.counts.thinAfterWidening.toString().padStart(5)} (${pct(rollup.counts.thinAfterWidening)})`);
  console.log(`Empty (0 bars):         ${rollup.counts.empty.toString().padStart(5)} (${pct(rollup.counts.empty)})`);
  console.log(`Errored:                ${rollup.counts.errored.toString().padStart(5)} (${pct(rollup.counts.errored)})`);
  console.log("\nBy widened-from step:");
  for (const [k, v] of Object.entries(rollup.byWidenedFrom).sort((a, b) => b[1] - a[1])) {
    console.log(`  from ${k.padEnd(6)} → ${v}`);
  }
  console.log("\nExample widened resolutions (first 10):");
  for (const e of rollup.exampleWidened.slice(0, 10)) {
    console.log(`  ${e.ticker.padEnd(14)} ${e.symbol.padEnd(14)} bars=${e.bars} · ${e.widenedFrom} → ${e.finalRange}`);
  }
  if (rollup.counts.thinAfterWidening + rollup.counts.empty > 0) {
    console.log("\nStill broken (first 15):");
    for (const s of rollup.stillBroken.slice(0, 15)) {
      console.log(`  ${s.ticker.padEnd(14)} ${s.symbol?.padEnd(14) ?? "?"} bars=${s.bars} ${s.error ? `err=${s.error}` : ""}`);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "audit-deployed-prices.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/audit-deployed-prices.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
