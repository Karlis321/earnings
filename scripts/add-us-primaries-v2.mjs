#!/usr/bin/env node
/**
 * Task 1: bulk US-primary population using crumb-authed v10 quoteSummary
 * (v7/quote requires auth and throttles hard). Serial: 2500ms spacing.
 *
 * For each company where any member has an edgarCik but no US-primary
 * listing exists in the registry, this script:
 *   1. Derives the US-primary Yahoo symbol from the sibling wrapper's
 *      base ticker (strip 34/35/32 BDR digits, F/Y OTC trailers).
 *   2. Fetches v10 quoteSummary?modules=price,assetProfile — for the
 *      new listing's exchange/currency/marketCap/industry.
 *   3. Adds the entity to the registry as a member of the existing
 *      company (companyId inherited, isCanonical=true — the auto-picker
 *      will keep it canonical on the next apply pass).
 *
 * Immediately after this script, run in order:
 *   node scripts/detect-entity-groups.mjs
 *   node scripts/apply-entity-groups.mjs
 *   node scripts/backfill-yahoo-timeseries.mjs --tickers=<newly-added>
 *   node scripts/rederive-sec-xbrl.mjs
 *   node scripts/run-estimator.mjs
 *   node scripts/shard-earnings.mjs
 *
 * Or invoke test-standing.mjs afterward to verify no invariants broke.
 *
 *   node scripts/add-us-primaries-v2.mjs --dry
 *   node scripts/add-us-primaries-v2.mjs --limit=50
 *   node scripts/add-us-primaries-v2.mjs
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
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : 250;
const INTERVAL_MS = 2500;
const UA = "Mozilla/5.0 (add-us-primaries-v2)";

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  if (CRUMB) return true;
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "follow",
  }).catch(() => null);
  const setCookie = r1?.headers.get("set-cookie") ?? "";
  COOKIE = setCookie
    .split(",")
    .map((s) => s.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE },
  });
  if (!r2.ok) return false;
  CRUMB = (await r2.text()).trim();
  return CRUMB.length > 0 && CRUMB.length < 24;
}

async function quoteSummary(symbol) {
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=price,assetProfile,defaultKeyStatistics` +
    `&crumb=${encodeURIComponent(CRUMB ?? "")}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const result = j?.quoteSummary?.result?.[0];
    if (!result) return { error: "empty result" };
    const price = result.price ?? {};
    const asset = result.assetProfile ?? {};
    return {
      ok: true,
      symbol: price.symbol ?? symbol,
      longName: price.longName ?? price.shortName ?? "",
      shortName: price.shortName ?? "",
      exchange: price.exchangeName ?? price.exchange ?? "",
      currency: price.currency ?? "USD",
      marketCap: price.marketCap?.raw ?? null,
      industry: asset.industry ?? null,
    };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

// Derive the likely US-primary Yahoo symbol from a foreign wrapper.
function guessUsPrimarySymbol(members) {
  for (const m of members) {
    const bloomBase = (m.ticker ?? "").split(/\s+/)[0];
    const clean = bloomBase
      .replace(/(34|35|32)$/g, "") // Brazilian BDR digits
      .replace(/[FY]$/, "")       // OTC pink trailers
      .replace(/(80|00)$/g, "");  // Thai number suffix
    if (clean.length >= 2 && /^[A-Z]+$/.test(clean)) return clean;
  }
  return null;
}

function capTierFor(m) {
  if (m == null) return "unknown";
  if (m >= 200e9) return "mega";
  if (m >= 10e9) return "large";
  if (m >= 2e9) return "mid";
  if (m >= 250e6) return "small";
  return "unknown";
}

function normalizeName(s) {
  if (!s) return "";
  return s
    .replace(
      /,?\s+(Inc\.?|Corporation|Corp\.?|Ltd\.?|Limited|Company|Co\.?|Group|Holdings|PLC|SA|AG|N\.?V\.?|SE|NV|Kabushiki\s+Kaisha)$/gi,
      "",
    )
    .trim();
}

async function main() {
  console.log(`add-us-primaries-v2 · dry=${DRY} limit=${LIMIT} interval=${INTERVAL_MS}ms`);

  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const byCompany = new Map();
  for (const e of reg.entities) {
    if (!e.companyId) continue;
    if (!byCompany.has(e.companyId)) byCompany.set(e.companyId, []);
    byCompany.get(e.companyId).push(e);
  }

  const targets = [];
  for (const [cid, members] of byCompany) {
    if (!members.some((m) => m.edgarCik)) continue;
    const hasUsPrimary = members.some((m) => {
      const parts = m.ticker.split(/\s+/);
      if (parts[1] !== "US") return false;
      if (/[FY]$/.test(parts[0])) return false;
      if (/(?:34|35|32)$/.test(parts[0])) return false;
      return true;
    });
    if (hasUsPrimary) continue;
    const canonical = members.find((m) => m.isCanonical) ?? members[0];
    const symbol = guessUsPrimarySymbol(members);
    if (!symbol) continue;
    targets.push({
      companyId: cid,
      cik: members.find((m) => m.edgarCik)?.edgarCik,
      benchmark: canonical.benchmark ?? "SPX",
      sectorTags: canonical.sectorTags ?? [],
      headlineMetrics: canonical.headlineMetrics ?? ["revenue_usd_m", "eps_usd"],
      industryGroup: canonical.industryGroup ?? null,
      newBloomberg: `${symbol} US`,
      newYahoo: symbol,
      marketCapProxy: canonical.marketCapUsd ?? 0,
      canonicalName: canonical.displayName,
    });
  }
  targets.sort((a, b) => (b.marketCapProxy ?? 0) - (a.marketCapProxy ?? 0));
  const slice = targets.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} · slicing top ${slice.length}`);

  if (!(await primeCrumb())) {
    console.error("Failed to prime Yahoo crumb — aborting");
    process.exit(1);
  }
  console.log(`crumb=${CRUMB?.slice(0, 6)}… · will fetch quoteSummary per symbol`);

  const asOf = new Date().toISOString().slice(0, 10);
  const added = [];
  const failures = [];
  const skipExisting = [];
  for (let i = 0; i < slice.length; i++) {
    const t = slice[i];
    if (reg.entities.some((e) => e.ticker === t.newBloomberg)) {
      skipExisting.push(t.newBloomberg);
      continue;
    }
    const meta = await quoteSummary(t.newYahoo);
    if (!meta.ok) {
      failures.push({ ticker: t.newBloomberg, error: meta.error });
    } else {
      const displayName = normalizeName(meta.longName || meta.shortName) || t.canonicalName;
      const entity = {
        ticker: t.newBloomberg,
        legalName: meta.longName,
        displayName,
        aliases: [meta.longName, displayName].filter((s, i, arr) => s && arr.indexOf(s) === i),
        exclusionAliases: [],
        sectorTags: t.sectorTags,
        cashtag: t.newYahoo,
        isCore: false,
        securityType: "operating",
        coverage: "headline",
        listing: meta.exchange ?? "",
        currency: meta.currency ?? "USD",
        benchmark: t.benchmark,
        headlineMetrics: t.headlineMetrics,
        catalystTypes: [],
        marketCapUsd: meta.marketCap,
        marketCapAsOf: meta.marketCap != null ? asOf : null,
        capTier: capTierFor(meta.marketCap),
        yahooSymbol: t.newYahoo,
        edgarCik: t.cik,
        industryGroup: meta.industry ?? t.industryGroup,
        industryGroupSource: meta.industry ? "direct" : (t.industryGroup ? "inherited" : undefined),
        industryGroupAsOf: (meta.industry || t.industryGroup) ? asOf : undefined,
        companyId: t.companyId,
        isCanonical: true,
      };
      reg.entities.push(entity);
      // Flip existing canonical of this companyId off
      for (const e of reg.entities) {
        if (e.companyId === t.companyId && e.ticker !== entity.ticker && e.isCanonical) {
          e.isCanonical = false;
        }
      }
      added.push({
        ticker: entity.ticker,
        name: displayName,
        cap: meta.marketCap,
        cik: t.cik,
        industry: meta.industry,
      });
    }
    if ((i + 1) % 20 === 0) {
      console.log(
        `  [${i + 1}/${slice.length}] added=${added.length} failures=${failures.length} existing=${skipExisting.length}`,
      );
    }
    // Sleep between requests
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  console.log(`\n=== Results ===`);
  console.log(`Added:            ${added.length}`);
  console.log(`Failures:         ${failures.length}`);
  console.log(`Existing (skip):  ${skipExisting.length}`);
  if (failures.length > 0) {
    console.log(`\nFailure sample:`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f.ticker} · ${f.error}`);
  }
  if (added.length > 0) {
    console.log(`\nAdded sample (top 15 by cap):`);
    for (const a of added.slice(0, 15)) {
      console.log(`  ${a.ticker.padEnd(12)} ${a.name.slice(0, 24).padEnd(24)} cap=${((a.cap ?? 0) / 1e9).toFixed(1)}B ind=${a.industry ?? "-"}`);
    }
  }

  if (DRY) {
    console.log("\nDry run — no registry write.");
    return;
  }
  await fs.writeFile(REGISTRY, JSON.stringify(reg, null, 2));
  console.log(`\n✓ wrote ${REGISTRY}`);
  console.log(
    "\nNext steps to close the acceptance criterion (empty canonicals are worse than what they replaced):",
  );
  console.log("  node scripts/detect-entity-groups.mjs && node scripts/apply-entity-groups.mjs");
  console.log("  node scripts/rederive-sec-xbrl.mjs        # populates SEC-verbatim financials");
  console.log("  node scripts/run-estimator.mjs            # populates estimator shells with correct labels");
  console.log("  node scripts/shard-earnings.mjs           # index refresh");
  console.log("  node scripts/test-standing.mjs            # verify invariants remain 0");
}

main().catch((e) => { console.error(e); process.exit(1); });
