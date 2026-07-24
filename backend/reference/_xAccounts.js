// Per-holding registry of OFFICIAL X (Twitter) account handles.
// Used by /api/tweets to pull each company's own posts via
// https://nitter.net/<handle>/rss.
//
// File is prefixed with `_` so Vercel does NOT expose it as an HTTP endpoint.
//
// Why Nitter profile RSS specifically
// ===================================
// - X killed every unauthenticated read path in 2023 (no public timeline,
//   no syndication, no Nitter SEARCH on any surviving instance).
// - Cookie-authenticated GraphQL scrapers work for a few weeks then break
//   (queryId rotates, features list rotates, accounts get banned).
// - Nitter's per-profile RSS is the one endpoint that has stayed stable.
//   It's a single GET, no auth, served fast, parses to clean RSS 2.0, and
//   gives us each company's own tweets — which is the most useful slice
//   anyway (IR announcements, executive comms, conference posts).
//
// Adding a handle
// ===============
//   1. Open https://nitter.net/<candidate-handle>/rss in a browser.
//   2. If it returns RSS with real items (not the Nitter 404 page),
//      add the mapping below.
//   3. Capitalisation matters for Nitter's URL — copy exactly.
//
// Missing handles
// ===============
// Several holdings have no findable / verifiable X account as of 2026-06:
// CENX, HBM, WRN, SHLE, DBG, SCMI, TOI. Tickers without an entry below
// are silently skipped — the rest of the tweet pipeline (StockTwits,
// Reddit, manual paste) still runs.

export const X_ACCOUNTS = {
  'BN US':    'Brookfield',     // Brookfield Corp
  'BOLSY US': 'B3_Oficial',     // B3 SA (Brasil, Bolsa, Balcão)
  'ABXX CN':  'abaxx_tech',     // Abaxx Technologies
  'TGB CN':   'TasekoMines',    // Taseko Mines
  'TNZ CN':   'TenazEnergy',    // Tenaz Energy
  'VLE CN':   'ValeuraEnergy',  // Valeura Energy
  'CS CN':    'CapstoneCopper', // Capstone Copper (per IR site footer)
};

export function handleFor(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  return X_ACCOUNTS[ticker] || null;
}
