// Controlled test for mentionsHolding + the previous fanoutNews
// displayName-substring pre-filter.
// Run: node scripts/test-mentions-holding.mjs

const MIN_ALIAS_LEN = 3;
const CN_SUFFIXES = ["TO", "V", "NE", "VN", "CN"];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBloomberg(ticker) {
  const m = ticker.trim().match(/^([A-Z0-9]+)\s+(US|CN|PA|FH|LN|AU|JP|HK|SW)$/i);
  if (!m) return null;
  return { base: m[1].toUpperCase(), exchange: m[2].toUpperCase() };
}

function collectAliases(entity) {
  const out = new Set();
  if (entity.displayName) out.add(entity.displayName.trim());
  if (entity.legalName) out.add(entity.legalName.trim());
  for (const a of entity.aliases ?? []) if (a?.trim()) out.add(a.trim());
  return [...out];
}

function mentionsHolding(text, entity) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  for (const a of collectAliases(entity)) {
    if (a.length < MIN_ALIAS_LEN) continue;
    if (/^[A-Za-z]{2,5}$/.test(a)) {
      const re = new RegExp(`\\b${escapeRegex(a)}\\b`, "i");
      if (re.test(text)) return true;
    } else if (lower.includes(a.toLowerCase())) {
      return true;
    }
  }
  const parsed = parseBloomberg(entity.ticker);
  if (!parsed) return false;
  const cashRe = new RegExp(`\\$${escapeRegex(parsed.base)}\\b`, "i");
  if (cashRe.test(text)) return true;
  if (parsed.exchange === "CN") {
    const suffixGroup = CN_SUFFIXES.map(escapeRegex).join("|");
    const suffixRe = new RegExp(
      `\\$?${escapeRegex(parsed.base)}\\.(?:${suffixGroup})\\b`,
      "i",
    );
    if (suffixRe.test(text)) return true;
  }
  return false;
}

const BN = {
  ticker: "BN US",
  displayName: "Brookfield",
  legalName: "Brookfield Corporation",
  aliases: ["Brookfield", "Brookfield Corp", "Brookfield Corporation", "$BN"],
};
const HBM = {
  ticker: "HBM US",
  displayName: "Hudbay Minerals",
  legalName: "Hudbay Minerals Inc.",
  aliases: ["Hudbay", "Hudbay Minerals", "HudBay"],
};
const TOI = {
  ticker: "TOI CN",
  displayName: "Topicus.com",
  legalName: "Topicus.com Inc.",
  aliases: ["Topicus.com", "Topicus"],
};
const CS = {
  ticker: "CS CN",
  displayName: "Capstone Copper",
  legalName: "Capstone Copper Corp.",
  aliases: ["Capstone Copper", "Capstone Mining"],
};

const cases = [
  ["Brookfield reports Q3 profit rise", BN],
  ["Hudbay Q3 EBITDA beats estimates", HBM],
  ["Hudbay reports Q3", HBM],
  ["Topicus wins Constellation deal", TOI],
  ["Copper prices fall on China demand", HBM],
  ["Brookfield Asset Management raises fund", BN],
  ["Capstone Copper trims 2026 guidance", CS],
  ["Capstone Mining hits milestone at Mantoverde", CS],
];

console.log("Column key:");
console.log("  mh   = mentionsHolding() (post-fix; the only filter now)");
console.log("  old  = headline.includes(displayName) (previous pre-filter)");
console.log();
console.log(
  "mh  old  headline",
);
for (const [h, e] of cases) {
  const mh = mentionsHolding(h, e);
  const old = h.toLowerCase().includes(e.displayName.toLowerCase());
  const mark = (v) => (v ? " Y " : " . ");
  console.log(`${mark(mh)}${mark(old)} "${h}" (${e.ticker})`);
}
