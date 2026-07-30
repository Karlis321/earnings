#!/usr/bin/env node
/**
 * For tickers whose Yahoo chart returned 0 bars in the audit, try
 * to resolve the correct Yahoo symbol via search and update the
 * registry. Uses displayName as the search query. Only writes when
 * the new symbol RETURNS BARS (guarding against another mismatch).
 *
 *   node scripts/fix-empty-graph-symbols.mjs [--dry]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const UA = "Mozilla/5.0 (fix-empty-graph-symbols)";
const REQUEST_TIMEOUT_MS = 12_000;

async function yahooSearch(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return { quotes: j?.quotes ?? [] };
  } catch (e) { return { error: e.message ?? "network" }; }
}

async function yahooBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!r.ok) return 0;
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    let bars = 0;
    for (let i = 0; i < timestamps.length; i++) if (timestamps[i] != null && closes[i] != null) bars++;
    return bars;
  } catch { return 0; }
}

async function main() {
  const audit = JSON.parse(await fs.readFile(path.join(OUT_DIR, "audit-price-graphs.json"), "utf-8"));
  const gaps = audit.gaps.graphEmptyOrError.filter((g) => g.ticker.endsWith(" US"));
  console.log(`Empty-graph US tickers to try: ${gaps.length}`);

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));

  const rollup = {
    schema: "fix-empty-graph-symbols/v1",
    generatedAt: new Date().toISOString(),
    totals: { attempted: 0, resolved: 0, unresolved: 0 },
    resolved: [],
    unresolved: [],
  };

  for (const g of gaps) {
    rollup.totals.attempted++;
    const entity = (reg.entities ?? []).find((e) => e.ticker === g.ticker);
    if (!entity) { rollup.totals.unresolved++; rollup.unresolved.push({ ticker: g.ticker, reason: "no-entity" }); continue; }
    const query = entity.displayName;
    // Skip when displayName is a numeric BB id (garbage — no useful search).
    if (!query || /^\d+$/.test(query)) {
      rollup.totals.unresolved++;
      rollup.unresolved.push({ ticker: g.ticker, reason: `bad-displayname=${query}` });
      continue;
    }
    const s = await yahooSearch(query);
    if (s.error) { rollup.totals.unresolved++; rollup.unresolved.push({ ticker: g.ticker, reason: `search-error=${s.error}` }); continue; }
    // Look for a US-exchange quote (NYSE, NASDAQ, AMEX). Skip .PK/.OB penny paths.
    const candidates = (s.quotes ?? []).filter((q) => /NASDAQ|NYSE|AMEX|Cboe|NMS/.test(q.exchDisp ?? q.exchange ?? ""));
    let chosen = null;
    for (const c of candidates.slice(0, 3)) {
      const bars = await yahooBars(c.symbol);
      if (bars > 0) { chosen = c; break; }
    }
    if (!chosen) {
      rollup.totals.unresolved++;
      rollup.unresolved.push({ ticker: g.ticker, displayName: query, reason: "no-us-listing-with-bars", candidatesTried: candidates.slice(0, 3).map((c) => c.symbol) });
      continue;
    }
    // Update entity.yahooSymbol.
    const before = entity.yahooSymbol;
    entity.yahooSymbol = chosen.symbol;
    rollup.totals.resolved++;
    rollup.resolved.push({ ticker: g.ticker, displayName: query, from: before, to: chosen.symbol, exchange: chosen.exchDisp });
  }

  if (!DRY && rollup.totals.resolved > 0) {
    fssync.writeFileSync(REG_PATH, JSON.stringify(reg, null, 2));
  }

  console.log(`\n=== fix-empty-graph-symbols ===`);
  console.log(`Attempted:   ${rollup.totals.attempted}`);
  console.log(`Resolved:    ${rollup.totals.resolved}`);
  console.log(`Unresolved:  ${rollup.totals.unresolved}`);
  console.log(`\nResolved:`);
  for (const r of rollup.resolved) console.log(`  ${r.ticker.padEnd(14)} ${r.from.padEnd(10)} → ${r.to.padEnd(10)} · ${r.displayName} (${r.exchange})`);
  console.log(`\nUnresolved:`);
  for (const u of rollup.unresolved) console.log(`  ${u.ticker.padEnd(14)} ${u.reason}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "fix-empty-graph-symbols.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/fix-empty-graph-symbols.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
