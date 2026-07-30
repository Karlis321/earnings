#!/usr/bin/env node
/**
 * Rewrite data/entity-registry.json to exactly match the portfolio listed
 * in prompt1.txt (24 tearsheets; 17 in dashboard scope; 7 funds out of
 * scope). Also updates data/shared-state.json watchlist.
 *
 * Fetches current market cap from Yahoo for each ticker (crumb-authed) so
 * capTier is accurate at write time. Run once when the portfolio changes.
 *
 *   node scripts/rewrite-registry.mjs
 *   node scripts/rewrite-registry.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
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

// ---------- Portfolio (from prompt1.txt) ----------
// yahooSymbol is what /v7/finance/quote resolves; ticker is Bloomberg-style
// used everywhere in the app.
const PORTFOLIO = [
  // Operating (11)
  {
    ticker: "ABXX CN", yahooSymbol: "ABXX.NE",
    legalName: "Abaxx Technologies Inc.", displayName: "Abaxx Technologies",
    aliases: ["Abaxx", "Abaxx Technologies", "Abaxx Exchange"],
    sectorTags: ["exchanges", "financial-services", "commodities", "technology"],
    cashtag: "ABXX", securityType: "operating", listing: "NEO", currency: "CAD",
    benchmark: "TSX", headlineMetrics: ["revenue_usd_m"], catalystTypes: [],
  },
  {
    ticker: "BN US", yahooSymbol: "BN",
    legalName: "Brookfield Corporation", displayName: "Brookfield",
    aliases: ["Brookfield", "Brookfield Corp", "Brookfield Corporation", "$BN"],
    exclusionAliases: ["Bambi"],
    sectorTags: ["financial-services", "alternative-asset-management"],
    cashtag: "BN", securityType: "operating", listing: "NYSE", currency: "USD",
    benchmark: "SPX", headlineMetrics: ["fee_bearing_capital_usd_b", "dr_eps_usd"],
    catalystTypes: [],
  },
  {
    ticker: "BOLSY US", yahooSymbol: "BOLSY",
    legalName: "B3 S.A. — Brasil, Bolsa, Balcão",
    displayName: "B3",
    aliases: ["B3", "B3 S.A.", "B3 Brasil Bolsa Balcao", "Brasil Bolsa Balcão"],
    sectorTags: ["exchanges", "financial-services", "brazil"],
    cashtag: "BOLSY", securityType: "operating", listing: "OTC", currency: "USD",
    benchmark: "IBOV", headlineMetrics: ["revenue_usd_m", "eps_usd"],
    catalystTypes: [],
  },
  {
    ticker: "CENX US", yahooSymbol: "CENX",
    legalName: "Century Aluminum Company", displayName: "Century Aluminum",
    aliases: ["Century Aluminum", "Century Al"],
    sectorTags: ["aluminum", "materials", "mining"],
    cashtag: "CENX", securityType: "operating", listing: "NASDAQ", currency: "USD",
    benchmark: "SPX", headlineMetrics: ["revenue_usd_m", "shipments_kt", "adj_ebitda_usd_m"],
    catalystTypes: [],
  },
  {
    ticker: "CS CN", yahooSymbol: "CS.TO",
    legalName: "Capstone Copper Corp.", displayName: "Capstone Copper",
    aliases: ["Capstone Copper", "Capstone Mining"],
    sectorTags: ["copper", "materials", "mining"],
    cashtag: "CS", securityType: "operating", listing: "TSX", currency: "CAD",
    benchmark: "HG=F", headlineMetrics: ["production_cu_kt", "c1_usd_lb", "revenue_usd_m"],
    catalystTypes: [],
  },
  {
    ticker: "HBM US", yahooSymbol: "HBM",
    legalName: "Hudbay Minerals Inc.", displayName: "Hudbay Minerals",
    aliases: ["Hudbay", "Hudbay Minerals", "HudBay"],
    sectorTags: ["copper", "materials", "mining"],
    cashtag: "HBM", securityType: "operating", listing: "NYSE", currency: "USD",
    benchmark: "HG=F", headlineMetrics: ["production_cu_kt", "c1_usd_lb", "revenue_usd_m"],
    catalystTypes: [],
  },
  {
    ticker: "SHLE CN", yahooSymbol: "SHLE.TO",
    legalName: "Source Energy Services Ltd.", displayName: "Source Energy Services",
    aliases: ["Source Energy Services", "Source Energy"],
    sectorTags: ["oil-gas-services", "energy"],
    cashtag: "SHLE", securityType: "operating", listing: "TSX", currency: "CAD",
    benchmark: "CL=F", headlineMetrics: ["revenue_usd_m"],
    catalystTypes: [],
  },
  {
    // Yahoo now returns "Trekor Metals Limited" for TGB; Taseko was renamed
    // in 2025 but old references + user's PDF still say "Taseko Mines".
    // Alias-match on both so news filtering catches either.
    ticker: "TGB US", yahooSymbol: "TGB",
    legalName: "Trekor Metals Limited",
    displayName: "Taseko Mines",
    aliases: ["Taseko Mines", "Taseko", "Trekor Metals", "Trekor"],
    sectorTags: ["copper", "materials", "mining"],
    cashtag: "TGB", securityType: "operating", listing: "NYSE American", currency: "USD",
    benchmark: "HG=F", headlineMetrics: ["production_cu_kt", "c1_usd_lb"],
    catalystTypes: [],
  },
  {
    ticker: "TNZ CN", yahooSymbol: "TNZ.TO",
    legalName: "Tenaz Energy Corp.", displayName: "Tenaz Energy",
    aliases: ["Tenaz Energy", "Tenaz"],
    sectorTags: ["oil-gas", "energy"],
    cashtag: "TNZ", securityType: "operating", listing: "TSX", currency: "CAD",
    benchmark: "CL=F", headlineMetrics: ["revenue_usd_m"],
    catalystTypes: [],
  },
  {
    ticker: "TOI CN", yahooSymbol: "TOI.V",
    legalName: "Topicus.com Inc.", displayName: "Topicus.com",
    aliases: ["Topicus.com", "Topicus"],
    sectorTags: ["software", "technology"],
    cashtag: "TOI", securityType: "operating", listing: "TSXV", currency: "CAD",
    benchmark: "TSX", headlineMetrics: ["revenue_usd_m", "adj_ebitda_usd_m"],
    catalystTypes: [],
  },
  {
    ticker: "VLE CN", yahooSymbol: "VLE.TO",
    legalName: "Valeura Energy Inc.", displayName: "Valeura Energy",
    aliases: ["Valeura Energy", "Valeura"],
    sectorTags: ["oil-gas", "energy"],
    cashtag: "VLE", securityType: "operating", listing: "TSX", currency: "CAD",
    benchmark: "CL=F", headlineMetrics: ["revenue_usd_m"],
    catalystTypes: [],
  },
  // Developers (3)
  {
    ticker: "DBG CN", yahooSymbol: "DBG.V",
    legalName: "Doubleview Gold Corp.", displayName: "Doubleview Gold",
    aliases: ["Doubleview Gold", "Doubleview"],
    sectorTags: ["gold", "copper", "developer", "mining"],
    cashtag: "DBG", securityType: "developer", listing: "TSXV", currency: "CAD",
    benchmark: "", headlineMetrics: [],
    catalystTypes: ["Drill Result", "Resource Update", "PEA"],
  },
  {
    ticker: "SCMI CN", yahooSymbol: "SCMI.V",
    legalName: "Selkirk Copper Mines Inc.", displayName: "Selkirk Copper Mines",
    aliases: ["Selkirk Copper Mines", "Selkirk Copper", "Selkirk"],
    sectorTags: ["copper", "developer", "mining"],
    cashtag: "SCMI", securityType: "developer", listing: "TSXV", currency: "CAD",
    benchmark: "", headlineMetrics: [],
    catalystTypes: ["Drill Result", "Resource Update"],
  },
  {
    ticker: "WRN US", yahooSymbol: "WRN",
    legalName: "Western Copper and Gold Corporation",
    displayName: "Western Copper and Gold",
    aliases: ["Western Copper", "Western Copper and Gold", "Casino Project"],
    sectorTags: ["copper", "gold", "developer", "mining"],
    cashtag: "WRN", securityType: "developer", listing: "NYSE American", currency: "USD",
    benchmark: "", headlineMetrics: [],
    catalystTypes: ["Feasibility Study", "Permit", "Drill Result"],
  },
  // ETFs (3)
  {
    ticker: "XEG CN", yahooSymbol: "XEG.TO",
    legalName: "iShares S&P/TSX Capped Energy Index ETF",
    displayName: "iShares Capped Energy",
    aliases: ["iShares Capped Energy", "XEG"],
    sectorTags: ["etf", "energy", "canada"],
    cashtag: "XEG", securityType: "etf", listing: "TSX", currency: "CAD",
    benchmark: "SPX", headlineMetrics: [],
    catalystTypes: [],
  },
  {
    ticker: "RIO FP", yahooSymbol: "RIO.PA",
    legalName: "Amundi MSCI Brazil UCITS ETF Acc",
    displayName: "Amundi MSCI Brazil",
    aliases: ["Amundi MSCI Brazil", "Amundi Brazil ETF"],
    sectorTags: ["etf", "brazil", "emerging-markets"],
    cashtag: "RIO", securityType: "etf", listing: "Euronext Paris", currency: "EUR",
    benchmark: "IBOV", headlineMetrics: [],
    catalystTypes: [],
  },
  {
    ticker: "GDXJ US", yahooSymbol: "GDXJ",
    legalName: "VanEck Junior Gold Miners ETF",
    displayName: "GDXJ Junior Gold Miners",
    aliases: ["GDXJ", "VanEck Junior Gold Miners", "Junior Gold Miners ETF"],
    sectorTags: ["etf", "gold", "mining"],
    cashtag: "GDXJ", securityType: "etf", listing: "NYSE Arca", currency: "USD",
    benchmark: "GC=F", headlineMetrics: [],
    catalystTypes: [],
  },
];

// ---------- Crumb + market-cap fetch ----------
let CRUMB = null;
let COOKIE_HEADER = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
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
  const r2 = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    { headers: { "User-Agent": UA, Cookie: COOKIE_HEADER } },
  );
  CRUMB = (await r2.text()).trim();
}

async function fetchMarketCaps() {
  await primeCrumb();
  const symbols = PORTFOLIO.map((p) => p.yahooSymbol);
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}&crumb=${encodeURIComponent(CRUMB)}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: COOKIE_HEADER } });
  const j = await r.json();
  const map = new Map();
  for (const q of j.quoteResponse?.result ?? []) map.set(q.symbol, q);
  return map;
}

function capTierFor(mc) {
  if (mc == null || Number.isNaN(mc)) return "unknown";
  if (mc >= 200_000_000_000) return "mega";
  if (mc >= 10_000_000_000) return "large";
  if (mc >= 2_000_000_000) return "mid";
  if (mc >= 250_000_000) return "small";
  return "unknown";
}

// Yahoo returns marketCap in the security's home currency (not always USD).
// Rough CAD/USD + EUR/USD conversion so capTier is honest across listings.
// Cron step 6 recomputes daily; this is just the seed snapshot.
const FX = {
  USD: 1.0,
  CAD: 0.735,
  EUR: 1.07,
  GBP: 1.27,
};
function toUsd(marketCap, currency) {
  if (marketCap == null) return null;
  const rate = FX[currency] ?? 1.0;
  return Math.round(marketCap * rate);
}

async function main() {
  console.log(`Rewrite registry from prompt1.txt · dry=${DRY}`);
  const quotes = await fetchMarketCaps();
  const asOf = new Date().toISOString().slice(0, 10);

  const entities = PORTFOLIO.map((p) => {
    const q = quotes.get(p.yahooSymbol);
    const marketCapLocal = q?.marketCap ?? null;
    const marketCapUsd = toUsd(marketCapLocal, q?.currency ?? p.currency);
    return {
      ticker: p.ticker,
      legalName: p.legalName,
      displayName: p.displayName,
      aliases: p.aliases,
      exclusionAliases: p.exclusionAliases ?? [],
      sectorTags: p.sectorTags,
      cashtag: p.cashtag,
      isCore: true,
      securityType: p.securityType,
      coverage: "deep",
      listing: p.listing,
      currency: p.currency,
      benchmark: p.benchmark,
      headlineMetrics: p.headlineMetrics,
      catalystTypes: p.catalystTypes,
      marketCapUsd,
      marketCapAsOf: marketCapLocal != null ? asOf : null,
      capTier: capTierFor(marketCapUsd),
      yahooSymbol: p.yahooSymbol,
    };
  });

  const registry = {
    schema: "entity-registry/v1",
    entities,
  };
  const sharedStatePath = path.join(ROOT, "data", "shared-state.json");
  const registryPath = path.join(ROOT, "data", "entity-registry.json");
  const existingSharedRaw = await fs.readFile(sharedStatePath, "utf8");
  const sharedState = JSON.parse(existingSharedRaw);
  sharedState.watchlist = entities.map((e) => e.ticker);
  sharedState.lastCommit = new Date().toISOString();

  console.log("\nPer-ticker snapshot:");
  for (const e of entities) {
    const mcM = e.marketCapUsd ? Math.round(e.marketCapUsd / 1e6) : "—";
    console.log(
      ` ${e.ticker.padEnd(10)} ${(e.displayName ?? "").padEnd(28)} ${e.securityType.padEnd(10)} ${e.capTier.padEnd(7)} $${String(mcM).padStart(7)}M`,
    );
  }
  console.log(`\nTotal: ${entities.length} entities.`);

  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
  await fs.writeFile(sharedStatePath, JSON.stringify(sharedState, null, 2));
  console.log(`\n✓ wrote ${registryPath}`);
  console.log(`✓ wrote ${sharedStatePath}`);
  console.log("Next: git add data/ && git commit && git push");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
