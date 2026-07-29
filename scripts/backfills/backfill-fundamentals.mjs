#!/usr/bin/env node
/**
 * Populate entity.fundamentals for every operating entity that has a
 * yahooSymbol. Mirrors cron step-3 collection: fetch quoteSummary with
 * financialData + defaultKeyStatistics, extract TTM figures, write
 * entity.fundamentals into data/entity-registry.json.
 *
 *   node scripts/backfill-fundamentals.mjs        # write
 *   node scripts/backfill-fundamentals.mjs --dry  # report only
 *   node scripts/backfill-fundamentals.mjs --portfolio
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const PORTFOLIO_ONLY = args.get("portfolio") === true;
const CONCURRENCY = 6;

const UA = "Mozilla/5.0";
let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const setCookies = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of setCookies) {
    const f = raw.split(";", 1)[0].trim();
    const eq = f.indexOf("=");
    if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
  }
  COOKIE = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: COOKIE } });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchTtm(yahooSymbol) {
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}` +
    `?modules=financialData,defaultKeyStatistics&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: COOKIE }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j.quoteSummary?.result?.[0];
    if (!res) return null;
    const fd = res.financialData ?? {};
    const ks = res.defaultKeyStatistics ?? {};
    const anyTtm = fd.totalRevenue?.raw != null || fd.ebitda?.raw != null || ks.trailingEps?.raw != null;
    if (!anyTtm) return null;
    return {
      totalRevenueTTM: fd.totalRevenue?.raw ?? null,
      ebitdaTTM: fd.ebitda?.raw ?? null,
      grossMargin: fd.grossMargins?.raw ?? null,
      operatingMargin: fd.operatingMargins?.raw ?? null,
      ebitdaMargin: fd.ebitdaMargins?.raw ?? null,
      revenueGrowth: fd.revenueGrowth?.raw ?? null,
      sharesOutstanding: ks.sharesOutstanding?.raw ?? null,
      enterpriseValue: ks.enterpriseValue?.raw ?? null,
      trailingEps: ks.trailingEps?.raw ?? null,
      forwardEps: ks.forwardEps?.raw ?? null,
      profitMargin: fd.profitMargins?.raw ?? null,
      currency: fd.financialCurrency ?? null,
      asOf: new Date().toISOString().slice(0, 10),
    };
  } catch {
    return null;
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`backfill-fundamentals · dry=${DRY} portfolio=${PORTFOLIO_ONLY}`);
  const crumb = await primeCrumb();
  if (!crumb) {
    console.error("crumb prime failed");
    process.exit(1);
  }
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  let targets = reg.entities.filter((e) => e.securityType === "operating" && e.yahooSymbol);
  if (PORTFOLIO_ONLY) targets = targets.filter((e) => e.isCore);
  console.log(`Targets: ${targets.length}`);

  let populated = 0;
  let empty = 0;
  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 50 === 0) console.log(`  [${idx}/${targets.length}] processed · +${populated}`);
    const ttm = await fetchTtm(entity.yahooSymbol);
    if (ttm) {
      entity.fundamentals = ttm;
      populated++;
    } else {
      empty++;
    }
  });

  console.log(`\nPopulated: ${populated} · empty (no Yahoo TTM): ${empty}`);
  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }
  await fs.writeFile(REGISTRY, JSON.stringify(reg, null, 2));
  console.log(`✓ wrote ${REGISTRY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
