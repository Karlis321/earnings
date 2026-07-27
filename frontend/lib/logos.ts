// Ticker → company-website-domain map for logo lookup.
// Logo served by logo.clearbit.com/<domain> (free, no key).
// Fallback: first letters of the display name.

// Kept in lockstep with the PORTFOLIO array in scripts/rewrite-registry.mjs
// (and mirrored fixture at lib/fixtures/registry.ts). Universe entities
// fall through to `tickerInitials` — Clearbit hits would be too noisy for
// 300+ tickers.
export const TICKER_DOMAINS: Record<string, string> = {
  "ABXX CN": "abaxx.tech",
  "BN US": "brookfield.com",
  "BOLSY US": "b3.com.br",
  "CENX US": "centuryaluminum.com",
  "CS CN": "capstonecopper.com",
  "HBM US": "hudbayminerals.com",
  "SHLE CN": "sourceenergy.ca",
  "TGB US": "tasekomines.com",
  "TNZ CN": "tenazenergy.com",
  "TOI CN": "topicus.com",
  "VLE CN": "valeuraenergy.com",
  "DBG CN": "doubleview.ca",
  "SCMI CN": "selkirkmetals.com",
  "WRN US": "westerncoppergold.com",
  "XEG CN": "blackrock.com",
  "RIO FP": "amundi.com",
  "GDXJ US": "vaneck.com",
};

export function domainForTicker(ticker: string): string | null {
  return TICKER_DOMAINS[ticker] ?? null;
}

export function logoUrl(ticker: string, size = 64): string | null {
  const d = domainForTicker(ticker);
  if (!d) return null;
  // Clearbit logo — free tier, no auth, returns transparent PNG.
  return `https://logo.clearbit.com/${d}?size=${size}`;
}

export function tickerInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "·";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
