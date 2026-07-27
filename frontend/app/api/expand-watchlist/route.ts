import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import {
  yahooScreener,
  getFxRates,
  toUsd,
  type ScreenerHit,
} from "@/server/vendors/yahoo";
import { capTierFor } from "@/lib/capTier";
import type { CapTier, SecurityType } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/expand-watchlist
//
// Body:
//   sector   required  "technology" | "materials" | "energy" | "etfs" | "developer" | "any"
//   capTier  optional  "small" | "mid" | "large" | "mega" | "any" (default "any")
//   count    optional  1..250 (default 50)
//   region   optional  "us" | "ca" | "gb" | "de" | "fr" | "any" (default "us")
//
// Returns:
//   { hits: CandidateEntity[], total: number, filteredExisting: number }
//
// Candidates already covered in the entity registry are filtered out; the
// analyst approves each add via /admin/expand → POST /api/entity-registry.

// User sector → Yahoo sector + optional developer-slice adjustments.
const SECTOR_MAP: Record<
  string,
  { yahooSector: string | null; quoteType: "EQUITY" | "ETF"; developer?: boolean }
> = {
  technology: { yahooSector: "Technology", quoteType: "EQUITY" },
  materials: { yahooSector: "Basic Materials", quoteType: "EQUITY" },
  energy: { yahooSector: "Energy", quoteType: "EQUITY" },
  etfs: { yahooSector: null, quoteType: "ETF" },
  // "Developer" = pre-revenue mining/exploration. Yahoo has no direct
  // filter — we screen Basic Materials, small-cap floor, and let the
  // analyst tag securityType on save.
  developer: {
    yahooSector: "Basic Materials",
    quoteType: "EQUITY",
    developer: true,
  },
  any: { yahooSector: null, quoteType: "EQUITY" },
};

// Cap tier → Yahoo market-cap bounds (USD).
const TIER_BOUNDS: Record<
  Exclude<CapTier, "unknown"> | "any",
  { min?: number; max?: number }
> = {
  mega: { min: 200_000_000_000 },
  large: { min: 10_000_000_000, max: 200_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  small: { min: 250_000_000, max: 2_000_000_000 },
  any: {},
};

interface Candidate {
  yahooSymbol: string;
  suggestedTicker: string; // Bloomberg-style
  name: string;
  exchange: string;
  currency: string | null;
  marketCapUsd: number | null;
  marketCapAsOf: string;
  capTier: CapTier;
  sector: string | null;
  industry: string | null;
  suggestedSectorTags: string[];
  suggestedSecurityType: SecurityType;
  region: string | null;
}

// Map Yahoo exchange codes to Bloomberg-style " US" / " CN" / " LN" / etc.
// Same coverage as EXCHANGE_MAP in vendors/yahoo.ts, reversed.
const YAHOO_TO_BB_EXCHANGE: Record<string, string> = {
  NMS: "US", NYQ: "US", ASE: "US", NGM: "US", NCM: "US",
  PCX: "US", NYS: "US", OEM: "US", OQX: "US", BTS: "US",
  TOR: "CN", VAN: "CN", CVE: "CN", NEO: "CN", CNX: "CN",
  LSE: "LN",
  PAR: "FP",
  GER: "GR", FRA: "GR", BER: "GR", DUS: "GR", HAM: "GR", MUN: "GR", STU: "GR",
  EBR: "BB",
  AMS: "NA",
  MIL: "IM",
  MCE: "SM",
  STO: "SS",
  OSL: "NO",
  CSE: "DC",
  SWX: "SW", EBS: "SW", VTX: "SW",
  VIE: "AV",
  SAO: "BZ",
  MEX: "MM",
  ASX: "AU",
  HKG: "HK",
  TYO: "JP", JPX: "JP", OSE: "JP",
  KSC: "KS",
  NSI: "IN", BOM: "IN",
  SES: "SP",
  HEL: "FH",
};

function bloombergFromYahoo(yahooSymbol: string, exchange: string): string {
  // Yahoo symbols like "NVDA" (US), "CS.TO" (Toronto), "RIO.PA" (Paris).
  // We use the exchange code Yahoo returns rather than parsing the suffix,
  // since some US-listed foreign issuers have no suffix.
  const base = yahooSymbol.split(".")[0].toUpperCase();
  const bb = YAHOO_TO_BB_EXCHANGE[exchange] ?? "US";
  return `${base} ${bb}`;
}

function suggestedSectorTags(hit: ScreenerHit, userSector: string): string[] {
  const tags = new Set<string>();
  if (hit.sector) tags.add(hit.sector.toLowerCase().replace(/\s+/g, "-"));
  if (hit.industry) tags.add(hit.industry.toLowerCase().replace(/\s+/g, "-"));
  if (userSector !== "any") tags.add(userSector);
  return Array.from(tags);
}

function suggestedSecurityType(
  hit: ScreenerHit,
  developer: boolean,
): SecurityType {
  if (hit.quoteType === "ETF") return "etf";
  if (developer) return "developer";
  return "operating";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      sector?: string;
      capTier?: string;
      count?: number;
      region?: string;
    };
    const sectorKey = (body.sector ?? "").toLowerCase();
    const mapping = SECTOR_MAP[sectorKey];
    if (!mapping) {
      return NextResponse.json(
        {
          error: "bad_request",
          message: `sector must be one of ${Object.keys(SECTOR_MAP).join(", ")}`,
        },
        { status: 400 },
      );
    }
    const tier = (body.capTier ?? "any") as keyof typeof TIER_BOUNDS;
    const bounds = TIER_BOUNDS[tier] ?? {};
    const region = (body.region ?? "us").toLowerCase();
    const count = Math.min(Math.max(body.count ?? 50, 1), 250);

    // Developer slice adds a small-cap floor if the caller didn't request
    // a specific tier (developers rarely exceed ~$2B).
    const marketCapMax =
      bounds.max ??
      (mapping.developer ? 2_000_000_000 : undefined);
    const marketCapMin =
      bounds.min ??
      (mapping.developer ? 20_000_000 : undefined);

    const existing = await store.readRegistry();
    const existingSet = new Set(existing.map((e) => e.ticker));

    // Over-fetch a bit to compensate for existing-ticker filtering.
    const [{ hits, total }, rates] = await Promise.all([
      yahooScreener({
        sector: mapping.yahooSector,
        region,
        quoteType: mapping.quoteType,
        size: Math.min(count * 2, 250),
        marketCapMin,
        marketCapMax,
      }),
      getFxRates(),
    ]);

    const asOf = new Date().toISOString().slice(0, 10);
    let filteredExisting = 0;
    const candidates: Candidate[] = [];
    for (const hit of hits) {
      const bb = bloombergFromYahoo(hit.symbol, hit.exchange);
      if (existingSet.has(bb)) {
        filteredExisting++;
        continue;
      }
      // Screener returns marketCap in home currency; convert before
      // storing on the candidate (capTier is USD-anchored).
      const marketCapUsd = toUsd(hit.marketCap, hit.currency ?? "USD", rates);
      candidates.push({
        yahooSymbol: hit.symbol,
        suggestedTicker: bb,
        name: hit.name,
        exchange: hit.exchange,
        currency: hit.currency,
        marketCapUsd,
        marketCapAsOf: asOf,
        capTier: capTierFor(marketCapUsd),
        sector: hit.sector,
        industry: hit.industry,
        suggestedSectorTags: suggestedSectorTags(hit, sectorKey),
        suggestedSecurityType: suggestedSecurityType(hit, !!mapping.developer),
        region: hit.region,
      });
      if (candidates.length >= count) break;
    }

    return NextResponse.json(
      { hits: candidates, total, filteredExisting, asOf },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: "server", message: (e as Error).message },
      { status: 500 },
    );
  }
}
