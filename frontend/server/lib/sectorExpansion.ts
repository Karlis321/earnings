// Sector-universe expansion — runs in the daily cron. Screens Yahoo for
// the top N by market cap per sector and adds any new tickers to the
// entity registry. Ported from scripts/expand-sectors.mjs into a
// server-side helper so the cron can call it inline.
//
// Add-only by design: entities that drop out of a sector's top-N in
// Yahoo's screener stay in the registry (we don't want to lose ingested
// events / market-cap history when a name has a bad quarter). The user
// can manually remove via DELETE /api/entity-registry/:ticker.

import type { CapTier, Entity, SecurityType } from "@/lib/types";
import { capTierFor } from "@/lib/capTier";
import {
  yahooScreener,
  yahooQuoteMetaBatch,
  type ScreenerHit,
} from "@/server/vendors/yahoo";

interface SectorDef {
  key: string;
  yahooSector: string | null;
  quoteType: "EQUITY" | "ETF";
  region: string;
  sectorTags: string[];
  securityType: SecurityType;
  benchmark: string;
  headlineMetrics: string[];
  catalystTypes: string[];
  marketCapMin?: number;
  marketCapMax?: number;
  // predefined not supported in the cron path yet — ETFs run against the
  // standard screener with region=us and sortField=intradaymarketcap
  // (which does work when we filter to top N per sector, unlike the
  // custom-sort-on-quoteType=ETF path which Yahoo rejects). If a sector
  // needs a predefined saved screen, add a fetcher branch here.
}

export const SECTOR_DEFS: SectorDef[] = [
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
  // Rest of the GICS-adjacent sectors. Yahoo's `sector` categorical uses
  // these labels verbatim.
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

// Yahoo exchange → Bloomberg suffix. Same table used in the one-shot
// script; unmapped exchanges skip cleanly instead of defaulting to US.
const YAHOO_TO_BB: Record<string, string> = {
  NMS: "US", NYQ: "US", ASE: "US", NGM: "US", NCM: "US",
  PCX: "US", NYS: "US", OEM: "US", OQX: "US", OQB: "US", OTC: "US",
  BTS: "US", PNK: "US",
  TOR: "CN", VAN: "CN", CVE: "CN", NEO: "CN", CNX: "CN", CDNX: "CN",
  LSE: "LN", PAR: "FP",
  GER: "GR", FRA: "GR", BER: "GR", DUS: "GR", HAM: "GR", MUN: "GR", STU: "GR",
  EBR: "BB", AMS: "NA", MIL: "IM", MCE: "SM", STO: "SS",
  OSL: "NO", CSE: "DC", SWX: "SW", EBS: "SW", VTX: "SW", VIE: "AV",
  HEL: "FH", CPH: "DC", ICE: "IR",
  ATH: "GA", WAR: "PW", BUD: "HB", PRA: "CP",
  IST: "TI",
  // BUE (Buenos Aires) intentionally omitted — Argentine CEDEARs report
  // marketCaps disconnected from the underlying issuer (AAPL.BA is
  // ~$1.56T; real AAPL is ~$4.89T). Skip cleanly instead of ingesting
  // duplicate wrappers.
  SAO: "BZ", MEX: "MM",
  ASX: "AU", HKG: "HK",
  TYO: "JP", JPX: "JP", OSE: "JP",
  KSC: "KS", KOE: "KS",
  NSI: "IN", BOM: "IN", BSE: "IN",
  SES: "SP", KLS: "MK", JKT: "IJ", SET: "TB",
  TAI: "TT",
  SHH: "CH", SHZ: "C1",
  TLV: "IT", JNB: "SJ", DFM: "UH", ADX: "UH",
};

function bloombergFromYahoo(
  yahooSymbol: string,
  exchange: string,
): string | null {
  const base = yahooSymbol.split(".")[0].toUpperCase();
  const bb = YAHOO_TO_BB[exchange];
  if (!bb) return null;
  return `${base} ${bb}`;
}

function buildEntity(
  hit: ScreenerHit,
  sectorDef: SectorDef,
  bb: string,
  marketCapUsd: number | null,
  asOf: string,
): Entity {
  const displayName =
    hit.name
      ?.replace(
        /,?\s+(Inc\.?|Corporation|Corp\.?|Ltd\.?|Limited|Company|Co\.?|Group|Holdings|PLC|SA|AG|N\.?V\.?)$/gi,
        "",
      )
      .trim() || hit.name;
  const industryTag = hit.industry
    ? hit.industry.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    : null;
  const sectorTags = new Set(sectorDef.sectorTags);
  if (industryTag) sectorTags.add(industryTag);
  const tier: CapTier = capTierFor(marketCapUsd);
  return {
    ticker: bb,
    legalName: hit.name,
    displayName,
    aliases: [hit.name, displayName].filter(
      (s, i, arr) => s && arr.indexOf(s) === i,
    ),
    exclusionAliases: [],
    sectorTags: Array.from(sectorTags),
    cashtag: hit.symbol.split(".")[0].toUpperCase(),
    isCore: false,
    securityType: sectorDef.securityType,
    coverage: "headline",
    listing: hit.exchange,
    currency: hit.currency ?? "USD",
    benchmark: sectorDef.benchmark,
    headlineMetrics: sectorDef.headlineMetrics,
    catalystTypes: sectorDef.catalystTypes,
    marketCapUsd,
    marketCapAsOf: marketCapUsd != null ? asOf : null,
    capTier: tier,
    yahooSymbol: hit.symbol,
    // Yahoo screener returns industry at the GICS-industry-group
    // granularity — persist it so the watchlist's cap-band × industry
    // grouping shows new entities without needing a re-backfill.
    industryGroup: hit.industry ?? null,
    industryGroupAsOf: hit.industry ? asOf : undefined,
  };
}

export interface SectorRefreshResult {
  perSector: Array<{ key: string; universe: number; added: number; skipped: number }>;
  newEntities: Entity[];
}

// Refreshes the sector universe by screening Yahoo. Existing entities
// (matched by Bloomberg-style ticker) stay put — this is add-only.
// `sizePerSector` defaults to 60 (matches the one-shot script).
export async function refreshSectorUniverse(
  existing: Entity[],
  sizePerSector = 60,
): Promise<SectorRefreshResult> {
  const asOf = new Date().toISOString().slice(0, 10);
  const existingSet = new Set(existing.map((e) => e.ticker));
  const perSector: SectorRefreshResult["perSector"] = [];
  const newEntities: Entity[] = [];
  // Accumulate additions across sectors so a name that qualifies for
  // multiple slices (e.g. technology + energy) is added once.
  const pendingSet = new Set<string>();

  for (const sectorDef of SECTOR_DEFS) {
    try {
      const { hits, total } = await yahooScreener({
        sector: sectorDef.yahooSector,
        region: sectorDef.region,
        quoteType: sectorDef.quoteType,
        size: sizePerSector,
        marketCapMin: sectorDef.marketCapMin,
        marketCapMax: sectorDef.marketCapMax,
      });
      let added = 0;
      let skipped = 0;
      for (const hit of hits) {
        if (!hit.symbol) continue;
        const bb = bloombergFromYahoo(hit.symbol, hit.exchange);
        if (!bb) {
          skipped++;
          continue;
        }
        if (existingSet.has(bb) || pendingSet.has(bb)) continue;
        // The screener already returned marketCap in USD via
        // yahooQuoteMetaBatch's FX pass (the screener itself doesn't
        // convert — but the value we get IS home-currency). Convert
        // via a follow-up quote call. Cheap: same crumb cookie.
        // Skip if marketCap missing entirely.
        if (hit.marketCap == null) {
          skipped++;
          continue;
        }
        pendingSet.add(bb);
        newEntities.push(
          buildEntity(hit, sectorDef, bb, null /* set below */, asOf),
        );
        added++;
      }
      perSector.push({
        key: sectorDef.key,
        universe: total,
        added,
        skipped,
      });
    } catch {
      perSector.push({ key: sectorDef.key, universe: 0, added: 0, skipped: 0 });
    }
  }

  // Second pass: fetch USD-converted market caps for the batch of new
  // entities in one call, populate marketCapUsd + capTier.
  if (newEntities.length > 0) {
    const symbols = newEntities
      .map((e) => e.yahooSymbol)
      .filter((s): s is string => !!s);
    const rows = await yahooQuoteMetaBatch(symbols);
    const bySymbol = new Map(rows.map((r) => [r.yahooSymbol, r]));
    for (const entity of newEntities) {
      const q = entity.yahooSymbol ? bySymbol.get(entity.yahooSymbol) : null;
      if (q?.marketCapUsd != null) {
        entity.marketCapUsd = q.marketCapUsd;
        entity.marketCapAsOf = asOf;
        entity.capTier = capTierFor(q.marketCapUsd);
      }
    }
  }

  // Third pass: attempt company assignment on new entities. Any new
  // entity whose edgarCik matches an existing entity's CIK joins that
  // company as a non-canonical listing. Otherwise it becomes its own
  // singleton company (canonical of itself). Keeps the invariant "every
  // entity has a companyId" that Part 2 established, without waiting
  // for the next full re-run of the detect/apply audit pipeline.
  if (newEntities.length > 0) {
    const cikToCompany = new Map<string, { companyId: string; industryGroup?: string | null }>();
    for (const e of existing) {
      if (e.edgarCik && e.companyId) {
        cikToCompany.set(e.edgarCik, {
          companyId: e.companyId,
          industryGroup: e.industryGroup,
        });
      }
    }
    for (const entity of newEntities) {
      let assigned = false;
      if (entity.edgarCik && cikToCompany.has(entity.edgarCik)) {
        const co = cikToCompany.get(entity.edgarCik)!;
        entity.companyId = co.companyId;
        entity.isCanonical = false; // joins an existing company as a listing
        // Inherit industryGroup if we don't have one for this new listing.
        if (!entity.industryGroup && co.industryGroup) {
          entity.industryGroup = co.industryGroup;
          entity.industryGroupSource = "inherited";
          entity.industryGroupAsOf = asOf;
        }
        assigned = true;
      }
      if (!assigned) {
        // Singleton company — same SHA-1(ticker) recipe as
        // scripts/apply-entity-groups.mjs. Import lazily to avoid a
        // top-level crypto pull for the (rare) code path here.
        const { createHash } = await import("node:crypto");
        const h = createHash("sha1")
          .update(entity.ticker)
          .digest("hex")
          .slice(0, 10);
        entity.companyId = `co-${h}`;
        entity.isCanonical = true;
      }
    }
  }

  return { perSector, newEntities };
}
