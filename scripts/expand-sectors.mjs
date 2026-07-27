#!/usr/bin/env node
/**
 * One-shot sector expansion. For each of Technology / Materials / Energy /
 * ETFs / Developers, pull the top N by market cap from Yahoo, dedupe against
 * the existing entity-registry.json, and write the merged result back.
 *
 *   node scripts/expand-sectors.mjs                 # default N=60 each
 *   node scripts/expand-sectors.mjs --size=100
 *   node scripts/expand-sectors.mjs --sector=technology
 *   node scripts/expand-sectors.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const SIZE = Number(args.get("size") ?? 60);
const ONLY = args.get("sector") ?? null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ---------- Crumb + cookie handshake (same as backfill.mjs) ----------
let CRUMB = null;
let COOKIE_HEADER = "";

async function primeCrumb() {
  if (CRUMB) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "manual",
  });
  const setCookies =
    typeof r1.headers.getSetCookie === "function"
      ? r1.headers.getSetCookie()
      : [r1.headers.get("set-cookie")].filter(Boolean);
  const pairs = new Map();
  for (const raw of setCookies) {
    const first = raw.split(";", 1)[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    pairs.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  COOKIE_HEADER = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE_HEADER) return null;
  const r2 = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
    },
  );
  if (!r2.ok) return null;
  const txt = (await r2.text()).trim();
  if (!txt || /Unauthorized|<html/i.test(txt)) return null;
  CRUMB = txt;
  return CRUMB;
}

async function yahooScreener({
  sector,
  region,
  quoteType,
  size,
  marketCapMin,
  marketCapMax,
  predefined, // e.g. "top_etfs_us" — bypasses the custom query
}) {
  const crumb = await primeCrumb();
  if (!crumb) return { hits: [], total: 0 };

  // ETF universe screening via custom query is broken on Yahoo's side
  // (they reject every candidate sort field). Use their predefined saved
  // screen instead — `top_etfs_us` returns the top ETFs by net assets.
  if (predefined) {
    const url =
      `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved` +
      `?scrIds=${encodeURIComponent(predefined)}&count=${Math.min(size, 250)}` +
      `&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: COOKIE_HEADER,
      },
    });
    if (!r.ok) return { hits: [], total: 0 };
    const j = await r.json();
    const block = j.finance?.result?.[0];
    if (!block) return { hits: [], total: 0 };
    return {
      hits: (block.quotes ?? []).map((q) => ({
        symbol: q.symbol ?? "",
        name: q.longName ?? q.shortName ?? "",
        exchange: q.exchange ?? "",
        currency: q.currency ?? null,
        marketCap: q.marketCap ?? q.netAssets ?? q.totalAssets ?? null,
        sector: q.sector ?? null,
        industry: q.industry ?? null,
        region: q.region ?? "us",
        quoteType: q.quoteType ?? quoteType,
      })),
      total: block.total ?? 0,
    };
  }

  const operands = [];
  if (quoteType !== "ETF" && sector) {
    operands.push({ operator: "EQ", operands: ["sector", sector] });
  }
  if (region && region !== "any") {
    operands.push({ operator: "EQ", operands: ["region", region] });
  }
  if (marketCapMin != null) {
    operands.push({
      operator: "GT",
      operands: ["intradaymarketcap", marketCapMin],
    });
  }
  if (marketCapMax != null) {
    operands.push({
      operator: "LT",
      operands: ["intradaymarketcap", marketCapMax],
    });
  }
  const body = {
    size: Math.min(Math.max(size, 1), 250),
    offset: 0,
    sortField: "intradaymarketcap",
    sortType: "desc",
    quoteType,
    topOperator: "AND",
    query:
      operands.length === 0
        ? { operator: "AND", operands: [] }
        : { operator: "AND", operands },
    userId: "",
    userIdType: "guid",
  };
  const r = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(crumb)}`,
    {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: COOKIE_HEADER,
      },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    return { hits: [], total: 0, err: `${r.status}` };
  }
  const j = await r.json();
  const block = j.finance?.result?.[0];
  if (!block) return { hits: [], total: 0 };
  return {
    hits: (block.quotes ?? []).map((q) => ({
      symbol: q.symbol ?? "",
      name: q.longName ?? q.shortName ?? "",
      exchange: q.exchange ?? "",
      currency: q.currency ?? null,
      marketCap: q.marketCap ?? null,
      sector: q.sector ?? null,
      industry: q.industry ?? null,
      region: q.region ?? null,
      quoteType: q.quoteType ?? quoteType,
    })),
    total: block.total ?? 0,
  };
}

// ---------- Bloomberg mapping + cap tiers ----------
const YAHOO_TO_BB = {
  // US
  NMS: "US", NYQ: "US", ASE: "US", NGM: "US", NCM: "US",
  PCX: "US", NYS: "US", OEM: "US", OQX: "US", OQB: "US", OTC: "US",
  BTS: "US", PNK: "US",
  // Canada
  TOR: "CN", VAN: "CN", CVE: "CN", NEO: "CN", CNX: "CN", CDNX: "CN",
  // Europe
  LSE: "LN", PAR: "FP",
  GER: "GR", FRA: "GR", BER: "GR", DUS: "GR", HAM: "GR", MUN: "GR", STU: "GR",
  EBR: "BB", AMS: "NA", MIL: "IM", MCE: "SM", STO: "SS",
  OSL: "NO", CSE: "DC", SWX: "SW", EBS: "SW", VTX: "SW", VIE: "AV",
  HEL: "FH", CPH: "DC", ICE: "IR",
  ATH: "GA", WAR: "PW", BUD: "HB", PRA: "CP",
  IST: "TI",
  // Latin America
  SAO: "BZ", MEX: "MM", BUE: "AF",
  // Asia-Pacific
  ASX: "AU", HKG: "HK",
  TYO: "JP", JPX: "JP", OSE: "JP",
  KSC: "KS", KOE: "KS",
  NSI: "IN", BOM: "IN", BSE: "IN",
  SES: "SP", KLS: "MK", JKT: "IJ", SET: "TB",
  TAI: "TT", // Taiwan
  // Mainland China
  SHH: "CH", SHZ: "C1",
  // Middle East / Africa
  TLV: "IT", JNB: "SJ", DFM: "UH", ADX: "UH",
};

function bloombergFromYahoo(yahooSymbol, exchange) {
  const base = yahooSymbol.split(".")[0].toUpperCase();
  const bb = YAHOO_TO_BB[exchange];
  if (!bb) return null; // unmapped exchange → skip rather than mis-tag
  return `${base} ${bb}`;
}

function capTierFor(mc) {
  if (mc == null || Number.isNaN(mc)) return "unknown";
  if (mc >= 200_000_000_000) return "mega";
  if (mc >= 10_000_000_000) return "large";
  if (mc >= 2_000_000_000) return "mid";
  if (mc >= 250_000_000) return "small";
  return "unknown";
}

// ---------- Sector definitions ----------
const SECTORS = [
  {
    key: "technology",
    yahooSector: "Technology",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["technology"],
    securityType: "operating",
    benchmark: "NDX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "materials",
    yahooSector: "Basic Materials",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["materials"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m"],
    catalystTypes: [],
  },
  {
    key: "energy",
    yahooSector: "Energy",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["energy"],
    securityType: "operating",
    benchmark: "CL=F",
    headlineMetrics: ["revenue_usd_m"],
    catalystTypes: [],
  },
  {
    key: "etfs",
    yahooSector: null,
    quoteType: "ETF",
    region: "us",
    predefined: "top_etfs_us", // custom ETF sort is broken on Yahoo's side
    sectorTags: ["etf"],
    securityType: "etf",
    benchmark: "SPX",
    headlineMetrics: [],
    catalystTypes: [],
  },
  {
    key: "developer",
    // Pre-revenue mining slice: Basic Materials with a small-cap ceiling.
    yahooSector: "Basic Materials",
    quoteType: "EQUITY",
    region: "any",
    marketCapMin: 20_000_000,
    marketCapMax: 2_000_000_000,
    sectorTags: ["materials", "mining", "developer"],
    securityType: "developer",
    benchmark: "",
    headlineMetrics: [],
    catalystTypes: ["Drill Result", "Resource Update"],
  },
];

// ---------- Entity builder ----------
function buildEntity(hit, sectorDef, asOf) {
  const bb = bloombergFromYahoo(hit.symbol, hit.exchange);
  if (!bb) return null; // exchange not on our Bloomberg map
  const displayName =
    hit.name
      ?.replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Ltd\.?|Limited|Company|Co\.?|Group|Holdings|PLC|SA|AG|N\.?V\.?)$/gi, "")
      .trim() || hit.name;
  const industryTag = hit.industry
    ? hit.industry.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    : null;
  const sectorTags = new Set(sectorDef.sectorTags);
  if (industryTag) sectorTags.add(industryTag);
  return {
    ticker: bb,
    legalName: hit.name,
    displayName,
    aliases: [hit.name, displayName].filter((s, i, arr) => s && arr.indexOf(s) === i),
    exclusionAliases: [],
    sectorTags: Array.from(sectorTags),
    cashtag: hit.symbol.split(".")[0].toUpperCase(),
    isCore: false, // added-from-screener defaults to headline coverage
    securityType: sectorDef.securityType,
    coverage: "headline",
    listing: hit.exchange,
    currency: hit.currency ?? "USD",
    benchmark: sectorDef.benchmark,
    headlineMetrics: sectorDef.headlineMetrics,
    catalystTypes: sectorDef.catalystTypes,
    marketCapUsd: hit.marketCap,
    marketCapAsOf: asOf,
    capTier: capTierFor(hit.marketCap),
    yahooSymbol: hit.symbol,
  };
}

// ---------- Main ----------
async function main() {
  console.log(`sector expansion · size=${SIZE} dry=${DRY}${ONLY ? ` sector=${ONLY}` : ""}`);
  const raw = await fs.readFile(REGISTRY_PATH, "utf8");
  const registry = JSON.parse(raw);
  const existing = new Set(registry.entities.map((e) => e.ticker));
  const asOf = new Date().toISOString().slice(0, 10);

  const per = [];
  const additions = [];
  for (const sectorDef of SECTORS) {
    if (ONLY && sectorDef.key !== ONLY) continue;
    console.log(`\n[${sectorDef.key}] fetching top ${SIZE} · ${sectorDef.yahooSector ?? sectorDef.quoteType} / ${sectorDef.region}…`);
    const { hits, total } = await yahooScreener({
      sector: sectorDef.yahooSector,
      region: sectorDef.region,
      quoteType: sectorDef.quoteType,
      size: SIZE,
      marketCapMin: sectorDef.marketCapMin,
      marketCapMax: sectorDef.marketCapMax,
      predefined: sectorDef.predefined,
    });
    let added = 0;
    let dupes = 0;
    let skipped = 0;
    const added_tickers = [];
    for (const hit of hits) {
      if (!hit.symbol) continue;
      const bb = bloombergFromYahoo(hit.symbol, hit.exchange);
      if (!bb) {
        skipped++; // exchange not on our Bloomberg map
        continue;
      }
      if (existing.has(bb)) {
        dupes++;
        continue;
      }
      const entity = buildEntity(hit, sectorDef, asOf);
      if (!entity) {
        skipped++;
        continue;
      }
      existing.add(bb);
      additions.push(entity);
      added++;
      added_tickers.push(bb);
    }
    per.push({ key: sectorDef.key, total, added, dupes, skipped });
    console.log(`  → +${added} new · ${dupes} already covered · universe ${total}`);
    if (added_tickers.length) {
      console.log(`  first: ${added_tickers.slice(0, 5).join(", ")}${added_tickers.length > 5 ? "…" : ""}`);
    }
  }

  console.log("\nSummary:");
  for (const p of per) console.log(` ${p.key.padEnd(12)} +${p.added} (${p.dupes} dupes · ${p.skipped ?? 0} unmapped · universe ${p.total})`);
  console.log(` total additions: ${additions.length}`);
  console.log(` registry before: ${registry.entities.length} → after: ${registry.entities.length + additions.length}`);

  if (DRY) {
    console.log("\nDry run — no write.");
    return;
  }
  registry.entities.push(...additions);
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`\n✓ wrote ${REGISTRY_PATH}`);
  console.log("Next: git add data/entity-registry.json && git commit && git push");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
