// Ticker → company-website-domain map for logo lookup.
// Logo served by logo.clearbit.com/<domain> (free, no key).
// Fallback: first letters of the display name.

export const TICKER_DOMAINS: Record<string, string> = {
  "INTC US": "intel.com",
  "NVDA US": "nvidia.com",
  "CS CN": "capstonecopper.com",
  "HBM CN": "hudbayminerals.com",
  "RIO PA": "riotinto.com",
  "BN US": "brookfield.com",
  "CENX US": "centuryaluminum.com",
  "TGB CN": "tasekomines.com",
  "SCMI CN": "sonorometals.com",
  "ABXX CN": "abaxx.tech",
  "SHLE US": "silverhornlithium.com",
  "NOK FH": "nokia.com",
  "GDXJ US": "vaneck.com",
  "COPX US": "globalxetfs.com",
  "URA US": "globalxetfs.com",
  "CCJ US": "cameco.com",
  "SILV CN": "silvercrestmetals.com",
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
