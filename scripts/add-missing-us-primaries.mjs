#!/usr/bin/env node
/**
 * Sweep 2 data population: add the missing US-primary listing for every
 * company where any member has an edgarCik but NO US-primary listing
 * exists. The old sector-expansion pipeline picked one listing per
 * company (Yahoo screener region=any), so US-CIK'd companies frequently
 * landed under their Mexican / Brazilian / Canadian mirror (MSFT MM,
 * NVDC34 BZ, AAPL34 BZ) with no US-primary sibling.
 *
 * For each affected company, look up the correct US-primary Yahoo
 * symbol via a lightweight yahooLookup, fetch marketCap + industry,
 * and insert the new listing into the registry as a non-canonical
 * member of the existing company. After insertion, re-run
 * apply-entity-groups.mjs to elect the new US-primary as canonical.
 *
 *   node scripts/add-missing-us-primaries.mjs --dry
 *   node scripts/add-missing-us-primaries.mjs --limit=25   # top 25 by cap
 *   node scripts/add-missing-us-primaries.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : 25;
const CONCURRENCY = 5;
const UA = "Mozilla/5.0 (earnings-dashboard-add-us-primary)";

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
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
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

// Derive the likely US-primary Yahoo symbol from a foreign wrapper.
// MSFT MM → yahooSymbol was "MSFT.MX" → US-primary Yahoo = "MSFT".
// AAPL34 BZ → "AAPL34.SA" → strip 34, US = "AAPL". NVDC34 BZ → strip.
function guessUsPrimarySymbol(members) {
  // Any US-suffix ticker in members whose Yahoo symbol has no dot suffix
  // is already US primary — but we only reach here when there isn't one.
  // So derive from the sibling with the shortest / cleanest base name.
  for (const m of members) {
    const bloomBase = (m.ticker ?? "").split(/\s+/)[0];
    // Strip common wrapper suffixes: BDR numbers (34/35/32),
    // ADR "F" / "Y" trailers, listing digits.
    const clean = bloomBase.replace(/(34|35|32|F|Y|80|00)$/g, "");
    if (clean.length >= 2 && /^[A-Z]+$/.test(clean)) return clean;
  }
  return null;
}

async function yahooQuoteMeta(symbol) {
  await primeCrumb();
  const url =
    `https://query2.finance.yahoo.com/v7/finance/quote` +
    `?symbols=${encodeURIComponent(symbol)}` +
    `&crumb=${encodeURIComponent(CRUMB ?? "")}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const row = j?.quoteResponse?.result?.[0];
    if (!row) return null;
    return {
      symbol: row.symbol,
      shortName: row.shortName ?? row.longName ?? "",
      longName: row.longName ?? row.shortName ?? "",
      exchange: row.exchange ?? "",
      currency: row.currency ?? "USD",
      marketCap: row.marketCap ?? row.netAssets ?? null,
      // v7/quote dropped `industry` — we'd need quoteSummary/assetProfile
      // for that, at extra cost. We'll leave industryGroup unset here;
      // the next daily cron's backfill will populate it.
    };
  } catch {
    return null;
  }
}

function capTierFor(m) {
  if (m == null) return "unknown";
  if (m >= 200e9) return "mega";
  if (m >= 10e9) return "large";
  if (m >= 2e9) return "mid";
  if (m >= 250e6) return "small";
  return "unknown";
}

function companyIdOf(canonicalTicker) {
  const h = createHash("sha1").update(canonicalTicker).digest("hex").slice(0, 10);
  return "co-" + h;
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
  console.log(`add-missing-us-primaries · dry=${DRY} limit=${LIMIT}`);
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
      canonicalName: canonical.displayName ?? canonical.legalName ?? symbol,
      cik: members.find((m) => m.edgarCik)?.edgarCik,
      marketCapProxy: canonical.marketCapUsd ?? 0,
      benchmark: canonical.benchmark ?? "SPX",
      sectorTags: canonical.sectorTags ?? [],
      headlineMetrics: canonical.headlineMetrics ?? ["revenue_usd_m", "eps_usd"],
      industryGroup: canonical.industryGroup ?? null,
      newBloomberg: `${symbol} US`,
      newYahoo: symbol,
    });
  }
  targets.sort((a, b) => (b.marketCapProxy ?? 0) - (a.marketCapProxy ?? 0));
  const slice = targets.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} · slicing top ${slice.length}`);

  const asOf = new Date().toISOString().slice(0, 10);
  const added = [];
  await pool(slice, CONCURRENCY, async (t) => {
    // Skip if the Bloomberg-style ticker already exists somehow
    if (reg.entities.some((e) => e.ticker === t.newBloomberg)) return;
    const meta = await yahooQuoteMeta(t.newYahoo);
    if (!meta) {
      console.log(`  [${t.newBloomberg}] lookup failed — skipping`);
      return;
    }
    const marketCapUsd = meta.marketCap;
    const displayName = meta.longName
      ?.replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Ltd\.?|Limited|Company|Co\.?|Group|Holdings|PLC|SA|AG|N\.?V\.?)$/gi, "")
      .trim() || t.canonicalName;
    const entity = {
      ticker: t.newBloomberg,
      legalName: meta.longName ?? t.canonicalName,
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
      marketCapUsd,
      marketCapAsOf: marketCapUsd != null ? asOf : null,
      capTier: capTierFor(marketCapUsd),
      yahooSymbol: t.newYahoo,
      edgarCik: t.cik,
      industryGroup: t.industryGroup,
      industryGroupSource: t.industryGroup ? "inherited" : undefined,
      industryGroupAsOf: t.industryGroup ? asOf : undefined,
      companyId: t.companyId,
      isCanonical: true, // the new US primary becomes canonical; script also flips existing canonical off
    };
    reg.entities.push(entity);
    added.push({
      ticker: entity.ticker,
      name: displayName,
      cap: marketCapUsd,
      cik: entity.edgarCik,
    });
    // Flip previous canonical off within the same companyId
    for (const e of reg.entities) {
      if (e.companyId === t.companyId && e.ticker !== entity.ticker && e.isCanonical) {
        e.isCanonical = false;
      }
    }
    console.log(
      `  + ${entity.ticker.padEnd(12)} ${displayName.slice(0, 24).padEnd(24)} cap=${(marketCapUsd ?? 0) / 1e9}B`,
    );
  });

  console.log(`\n=== Added ===\n  ${added.length} new US-primary listings`);
  if (DRY) {
    console.log("Dry run — no registry write.");
    return;
  }
  await fs.writeFile(REGISTRY, JSON.stringify(reg, null, 2));
  console.log(`✓ wrote ${REGISTRY}`);
  console.log(
    "\nNext: re-run scripts/apply-entity-groups.mjs to re-assign isCanonical if the auto-picker would prefer these new listings.",
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
