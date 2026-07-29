// Smoke-check the Google News URL builder for a handful of entities.
// Run: node scripts/test-entity-news-url.mjs

function buildGoogleNewsUrl(tokens, days) {
  const q = tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" OR ");
  const trimmed = q.slice(0, 480);
  const params = new URLSearchParams({
    q: `${trimmed} when:${days}d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

const MIN_ALIAS_LEN = 3;
const CN_SUFFIXES = ["TO", "V", "NE", "VN", "CN"];

function parseBloomberg(t) {
  const m = t.trim().match(/^([A-Z0-9]+)\s+(US|CN|PA|FH|LN|AU|JP|HK|SW)$/i);
  if (!m) return null;
  return { base: m[1].toUpperCase(), exchange: m[2].toUpperCase() };
}
function collectAliases(e) {
  const s = new Set();
  if (e.displayName) s.add(e.displayName.trim());
  if (e.legalName) s.add(e.legalName.trim());
  for (const a of e.aliases ?? []) if (a?.trim()) s.add(a.trim());
  return [...s];
}
function tickerSearchTokens(entity) {
  const tokens = new Set();
  for (const a of collectAliases(entity)) {
    if (a.length >= MIN_ALIAS_LEN) tokens.add(a);
  }
  if (entity.cashtag) tokens.add(`$${entity.cashtag}`);
  const parsed = parseBloomberg(entity.ticker);
  if (parsed) {
    tokens.add(`$${parsed.base}`);
    if (parsed.exchange === "CN") {
      for (const sfx of CN_SUFFIXES) tokens.add(`${parsed.base}.${sfx}`);
    }
  }
  return [...tokens];
}

const entities = [
  {
    ticker: "HBM US",
    displayName: "Hudbay Minerals",
    legalName: "Hudbay Minerals Inc.",
    aliases: ["Hudbay", "Hudbay Minerals", "HudBay"],
    cashtag: "HBM",
  },
  {
    ticker: "BOLSY US",
    displayName: "B3",
    legalName: "B3 S.A.",
    aliases: ["B3", "B3 S.A.", "Brasil Bolsa Balcao"],
    cashtag: "BOLSY",
  },
  {
    ticker: "TOI CN",
    displayName: "Topicus.com",
    legalName: "Topicus.com Inc.",
    aliases: ["Topicus.com", "Topicus"],
    cashtag: "TOI",
  },
];

for (const e of entities) {
  const tokens = tickerSearchTokens(e);
  const url = buildGoogleNewsUrl(tokens, 14);
  console.log(`\n${e.ticker} (${e.displayName})`);
  console.log(`  tokens: ${JSON.stringify(tokens)}`);
  console.log(`  url:    ${url}`);
}
