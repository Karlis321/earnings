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
  // Latin America — BUE (Buenos Aires) intentionally omitted: those
  // listings are Argentine CEDEARs (depositary receipts on foreign
  // issuers) whose Yahoo marketCap is disconnected from the underlying
  // listing (e.g. AAPL.BA reports ~$1.56T vs Apple's ~$4.89T on Nasdaq).
  // Argentine-domiciled issuers are rare in our sectors, so exclusion
  // is the pragmatic trade-off.
  SAO: "BZ", MEX: "MM",
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

// FX conversion — mirrors server/vendors/yahoo.ts fallback table so
// non-USD market caps aren't treated as USD. Rate = USD per 1 unit of CCY.
// Live rates from Yahoo's `<CCY>USD=X` override these at runtime; here we
// use the same fallback so the one-shot script is self-contained.
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

// Live-rate fetch: hit Yahoo's `<CCY>USD=X` cross-rates once per run.
async function fetchLiveFxRates() {
  const symbols = Object.keys(FX_FALLBACK)
    .filter((c) => c !== "USD")
    .map((c) => `${c}USD=X`);
  const rates = { USD: 1 };
  try {
    const crumb = await primeCrumb();
    if (!crumb) throw new Error("no crumb");
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote" +
      `?symbols=${encodeURIComponent(symbols.join(","))}&crumb=${encodeURIComponent(crumb)}`;
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
  // Rest of the GICS-adjacent sectors. Yahoo's `sector` categorical
  // uses these labels verbatim.
  {
    key: "financials",
    yahooSector: "Financial Services",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["financials", "financial-services"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "healthcare",
    yahooSector: "Healthcare",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["healthcare"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "industrials",
    yahooSector: "Industrials",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["industrials"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "consumer-cyclical",
    yahooSector: "Consumer Cyclical",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["consumer-cyclical"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "consumer-defensive",
    yahooSector: "Consumer Defensive",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["consumer-defensive"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "communication",
    yahooSector: "Communication Services",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["communication-services"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "utilities",
    yahooSector: "Utilities",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["utilities"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    key: "real-estate",
    yahooSector: "Real Estate",
    quoteType: "EQUITY",
    region: "any",
    sectorTags: ["real-estate"],
    securityType: "operating",
    benchmark: "SPX",
    headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
];

// ---------- Entity builder ----------
function buildEntity(hit, sectorDef, asOf, fxRates) {
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
  const marketCapUsd = toUsd(hit.marketCap, hit.currency ?? "USD", fxRates);
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
    marketCapUsd,
    marketCapAsOf: marketCapUsd != null ? asOf : null,
    capTier: capTierFor(marketCapUsd),
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

  const fxRates = await fetchLiveFxRates();
  const liveCcys = Object.keys(fxRates).filter((c) => c !== "USD" && fxRates[c] !== FX_FALLBACK[c]);
  console.log(`FX: live rates for ${liveCcys.length}/${Object.keys(FX_FALLBACK).length - 1} currencies`);

  // Default banded pass — for each equity sector, screen small / mid /
  // large separately with 25 per band. ETFs + the developer slice keep
  // their existing custom market-cap ranges (defined inline on the def).
  const DEFAULT_BANDS = [
    { key: "large", min: 10_000_000_000, max: 200_000_000_000, size: 25 },
    { key: "mid", min: 2_000_000_000, max: 10_000_000_000, size: 25 },
    { key: "small", min: 250_000_000, max: 2_000_000_000, size: 25 },
  ];

  const per = [];
  const additions = [];
  for (const sectorDef of SECTORS) {
    if (ONLY && sectorDef.key !== ONLY) continue;
    // Sectors with explicit marketCapMin/Max (developer) or ETF
    // (predefined) run once as-is. Everything else runs three banded
    // sub-screens per default bands.
    const runs =
      sectorDef.marketCapMin != null ||
      sectorDef.marketCapMax != null ||
      sectorDef.quoteType === "ETF"
        ? [
            {
              label: sectorDef.key,
              size: SIZE,
              min: sectorDef.marketCapMin,
              max: sectorDef.marketCapMax,
            },
          ]
        : DEFAULT_BANDS.map((b) => ({
            label: `${sectorDef.key} · ${b.key}`,
            size: b.size,
            min: b.min,
            max: b.max,
          }));

    for (const run of runs) {
      console.log(
        `\n[${run.label}] fetching top ${run.size} · ${sectorDef.yahooSector ?? sectorDef.quoteType} / ${sectorDef.region}` +
          (run.min || run.max
            ? ` · cap ${run.min ? `$${(run.min / 1e9).toFixed(1)}B` : "0"}-${run.max ? `$${(run.max / 1e9).toFixed(1)}B` : "∞"}`
            : "") +
          "…",
      );
      const { hits, total } = await yahooScreener({
        sector: sectorDef.yahooSector,
        region: sectorDef.region,
        quoteType: sectorDef.quoteType,
        size: run.size,
        marketCapMin: run.min,
        marketCapMax: run.max,
        predefined: sectorDef.predefined,
      });
      let added = 0;
      let dupes = 0;
      let skipped = 0;
      const added_tickers = [];
      for (const hit of hits) {
        if (!hit.symbol) continue;
        const bb = bloombergFromYahoo(hit.symbol, hit.exchange);
        if (!bb) { skipped++; continue; }
        if (existing.has(bb)) { dupes++; continue; }
        const entity = buildEntity(hit, sectorDef, asOf, fxRates);
        if (!entity) { skipped++; continue; }
        existing.add(bb);
        additions.push(entity);
        added++;
        added_tickers.push(bb);
      }
      per.push({ key: run.label, total, added, dupes, skipped });
      console.log(`  → +${added} new · ${dupes} already covered · universe ${total}`);
      if (added_tickers.length) {
        console.log(`  first: ${added_tickers.slice(0, 5).join(", ")}${added_tickers.length > 5 ? "…" : ""}`);
      }
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
