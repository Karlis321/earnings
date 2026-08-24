// Family classification for the /themes filter chips. Groups the
// long tail of sector tags into 8 broad families so the reader can
// focus on one industry area at a time. The mapping is opinionated
// but stable — every sector we see today maps to exactly one family.
//
// Unknown/new sectors fall through to "other" so the chip strip is
// exhaustive (no ticker silently drops out of the filter view).

export type SectorFamily =
  | "metals"
  | "energy"
  | "tech"
  | "financials"
  | "healthcare"
  | "consumer"
  | "industrials"
  | "real-estate"
  | "other";

const SECTOR_TO_FAMILY: Record<string, SectorFamily> = {
  // Metals & mining
  mining: "metals",
  materials: "metals",
  copper: "metals",
  gold: "metals",
  silver: "metals",
  aluminum: "metals",
  platinum: "metals",

  // Energy (fossil + power infra)
  "oil-gas": "energy",
  "oil-gas-services": "energy",
  "natural-gas": "energy",
  energy: "energy",
  utilities: "energy",

  // Tech + comms
  technology: "tech",
  software: "tech",
  semiconductors: "tech",
  "communication-services": "tech",

  // Financials (incl. asset management, exchanges)
  financials: "financials",
  "financial-services": "financials",
  "alternative-asset-management": "financials",
  exchanges: "financials",
  banks: "financials",
  insurance: "financials",

  // Healthcare
  healthcare: "healthcare",
  pharmaceuticals: "healthcare",
  biotech: "healthcare",

  // Consumer
  "consumer-cyclical": "consumer",
  "consumer-defensive": "consumer",
  retail: "consumer",

  // Industrials
  industrials: "industrials",
  aerospace: "industrials",
  transportation: "industrials",

  // Real estate — its own bucket (S&P split it out from financials
  // in 2016 and it behaves differently from banks/asset managers).
  "real-estate": "real-estate",
  reits: "real-estate",
};

export function familyOf(sector: string): SectorFamily {
  return SECTOR_TO_FAMILY[sector] ?? "other";
}

// Order + labels for the chip strip. Includes "all" as the leader
// and "other" as the trailer to hold the long tail.
export const FAMILY_ORDER: Array<{ id: SectorFamily | "all"; label: string }> =
  [
    { id: "all", label: "All" },
    { id: "metals", label: "Metals" },
    { id: "energy", label: "Energy" },
    { id: "tech", label: "Tech" },
    { id: "financials", label: "Financials" },
    { id: "real-estate", label: "Real estate" },
    { id: "healthcare", label: "Healthcare" },
    { id: "consumer", label: "Consumer" },
    { id: "industrials", label: "Industrials" },
    { id: "other", label: "Other" },
  ];
