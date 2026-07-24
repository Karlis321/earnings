// FinTwit handle registry.
//
// Hand-picked roster of high-signal accounts grouped by topic affinity.
// When /api/tweets fires for a stock or theme, the matching accounts
// (via `accountsForTopics`) get polled in parallel via TwitterAPI.io's
// `last_tweets` endpoint, and their recent tweets are filtered against
// the holding/theme keyword set. Surfaces analyst / journalist /
// fund-manager commentary that the per-ticker search alone wouldn't
// catch (these accounts often discuss holdings without using the
// exact name or cashtag — fragments like "BAM is buying", "Brookfield
// just signed", "the deficit chart is wild" — that don't pass a
// strict name match but do pass `mentionsHolding`).
//
// Topics
// ======
//   macro       — broad economy / rates / inflation
//   rates       — monetary policy / yield curve
//   equities    — general stock market
//   commodities — overall commodity macro
//   mining      — mining sector specifically
//   copper      — copper-focused
//   gold        — gold + precious metals
//   oil-gas     — energy / oil + gas
//   aluminum    — aluminum
//   uranium     — uranium / nuclear
//   financials  — banks / asset managers / insurance
//   real-estate — REITs / property markets
//   software    — software / tech
//   short-selling — short sellers / activist research
//   brazil      — Brazilian markets specifically
//   em          — broader emerging markets
//   journalists — newsrooms reporting in real time
//
// Handles are KNOWN-GOOD accounts as of project setup. Pruned/extended
// over time. Each entry: { handle, topics: [...] }.
//
// Defaults
// ========
// Accounts without topical match still won't surface unless the
// account explicitly mentions the holding — the FinTwit poll is
// content-filtered, not blanket-included. So this list errs toward
// breadth (~60 accounts) without flooding any one feed.

export const FINTWIT_ACCOUNTS = [
  // ---- Macro / rates / global FX ----
  { handle: 'LizAnnSonders',     topics: ['macro', 'equities', 'rates'] },
  { handle: 'SoberLook',         topics: ['macro', 'rates'] },
  { handle: 'TheStalwart',       topics: ['macro', 'equities'] },
  { handle: 'jasonzweigwsj',     topics: ['macro', 'equities', 'journalists'] },
  { handle: 'TheTerminal',       topics: ['macro', 'equities', 'journalists'] },
  { handle: 'CarlQuintanilla',   topics: ['macro', 'equities', 'journalists'] },
  { handle: 'StevenJSiwert',     topics: ['macro', 'rates'] },
  { handle: 'jnordvig',          topics: ['macro', 'rates', 'em'] },
  { handle: 'M_McDonough',       topics: ['macro'] },
  { handle: 'business',          topics: ['macro', 'equities', 'journalists'] },
  { handle: 'WSJmarkets',        topics: ['macro', 'equities', 'journalists'] },
  { handle: 'FT',                topics: ['macro', 'equities', 'journalists'] },
  { handle: 'ReutersBiz',        topics: ['macro', 'equities', 'journalists'] },

  // ---- Commodities — broad ----
  { handle: 'Goehring_Roz',      topics: ['commodities', 'oil-gas', 'mining', 'uranium'] },
  { handle: 'LawrenceLepard',    topics: ['commodities', 'gold', 'mining', 'macro'] },
  { handle: 'rcwhalen',          topics: ['commodities', 'financials'] },
  { handle: 'PauloMacro',        topics: ['commodities', 'macro', 'em'] },
  { handle: 'donutshorts',       topics: ['commodities', 'oil-gas', 'mining'] },
  { handle: 'MichaelKantro',     topics: ['macro', 'commodities'] },

  // ---- Mining specifically ----
  { handle: 'TheBubbleBubble',   topics: ['mining', 'commodities', 'macro'] },
  { handle: 'IKunaev',           topics: ['mining', 'copper'] },
  { handle: 'MiningWeekly',      topics: ['mining', 'journalists'] },
  { handle: 'northernminer',     topics: ['mining', 'gold', 'copper', 'journalists'] },
  { handle: 'kitco',             topics: ['mining', 'gold', 'journalists'] },
  { handle: 'crescatkevin',      topics: ['mining', 'gold', 'commodities'] },
  { handle: 'OttoRock1',         topics: ['mining', 'copper', 'gold'] },
  { handle: 'palisaderadio',     topics: ['mining', 'gold', 'commodities'] },

  // ---- Copper ----
  { handle: 'ole_s_hansen',      topics: ['commodities', 'copper', 'gold'] },
  { handle: 'CopperWolverine',   topics: ['copper', 'mining'] },
  { handle: 'StPeterBird',       topics: ['copper', 'mining'] },

  // ---- Gold + precious metals ----
  { handle: 'PeterSchiff',       topics: ['gold', 'macro'] },
  { handle: 'KitcoNews',         topics: ['gold', 'journalists'] },
  { handle: 'goldseek',          topics: ['gold', 'mining'] },

  // ---- Oil / gas / energy ----
  { handle: 'HFI_Research',      topics: ['oil-gas', 'commodities'] },
  { handle: 'JKempEnergy',       topics: ['oil-gas', 'journalists'] },
  { handle: 'eric_nuttall',      topics: ['oil-gas', 'commodities'] },
  { handle: 'WSJenergy',         topics: ['oil-gas', 'journalists'] },
  { handle: 'OilGasNewsAR',      topics: ['oil-gas'] },

  // ---- Uranium ----
  { handle: 'UraniumInsider',    topics: ['uranium', 'mining'] },
  { handle: 'Mr_Mason',          topics: ['uranium', 'mining'] },

  // ---- Aluminum / industrial metals ----
  { handle: 'reuters_meta',      topics: ['aluminum', 'commodities', 'mining', 'journalists'] },
  { handle: 'fastmarkets',       topics: ['aluminum', 'commodities', 'mining', 'journalists'] },

  // ---- Financials / Brookfield / asset managers ----
  { handle: 'Carl_C_Icahn',      topics: ['financials', 'equities'] },
  { handle: 'NickatFP',          topics: ['financials', 'equities'] },
  { handle: 'CullenRoche',       topics: ['financials', 'macro'] },
  { handle: 'cullenroche',       topics: ['financials', 'macro'] },
  { handle: 'AndrewLBerkin',     topics: ['financials', 'equities'] },
  { handle: 'NetInterestPod',    topics: ['financials', 'equities'] },

  // ---- Real estate / REITs (Brookfield-relevant) ----
  { handle: 'TheRealDeal',       topics: ['real-estate', 'journalists'] },
  { handle: 'urbandigsnyc',      topics: ['real-estate'] },

  // ---- Software / tech (Topicus-relevant) ----
  { handle: 'MBI_Deepdives',     topics: ['software', 'equities', 'financials'] },
  { handle: 'EmergingMoats',     topics: ['software', 'equities'] },
  { handle: 'punchcardinvest',   topics: ['software', 'equities'] },

  // ---- Brazil / LatAm ----
  { handle: 'brazil',            topics: ['brazil', 'em', 'journalists'] },
  { handle: 'JoaquimLevy',       topics: ['brazil', 'em'] },
  { handle: 'AndreEsteves',      topics: ['brazil', 'em', 'financials'] },
  { handle: 'EMSovereign',       topics: ['em', 'macro'] },
  { handle: 'samirakawakami',    topics: ['brazil', 'em', 'journalists'] },

  // ---- Short-selling / activist research ----
  { handle: 'HindenburgRes',     topics: ['short-selling', 'equities'] },
  { handle: 'muddywatersre',     topics: ['short-selling', 'equities'] },
  { handle: 'CitronResearch',    topics: ['short-selling', 'equities'] },
  { handle: 'BearCaveSubstack',  topics: ['short-selling', 'equities'] },

  // ---- Other high-signal voices ----
  { handle: 'biancoresearch',    topics: ['macro', 'rates'] },
  { handle: 'davidcervantes',    topics: ['macro', 'commodities'] },
  { handle: 'SteveBrice',        topics: ['equities', 'macro'] },
  { handle: 'WallStCynic',       topics: ['equities', 'macro'] },
];

// Per-ticker topic seed list — what FinTwit topics to poll for each
// core holding. Watchlist additions and themes use type/region heuristics
// instead (see `topicsForTheme`).
// Per-ticker topic affinity. Derived from the canonical entity
// registry's `sectorTags` field at data/entity-registry.json. The
// downstream consumer `accountsForTopics` does set-intersection of
// these topics against each FinTwit handle's topic list — extra tags
// in the registry (e.g. "junior-mining", "frac-sand", "yukon") that
// don't map to any FinTwit handle are harmless; they just won't add
// handles. They become useful in the Phase 3 relevance gate which
// uses sectorTags for topic-overlap scoring.
import { getAllEntities, getSectorTags } from './_entityRegistry.js';

export const TICKER_TOPICS = (() => {
  const out = {};
  for (const e of getAllEntities()) {
    if (e && typeof e.ticker === 'string') {
      out[e.ticker] = getSectorTags(e.ticker);
    }
  }
  return out;
})();

// Theme-level topic seeds derived from theme.type + theme.region +
// heuristic keyword scan. Returns an array of topic strings that
// `accountsForTopics` then maps to FinTwit handles.
const TYPE_TOPIC_SEEDS = {
  macro:         ['macro', 'rates', 'equities'],
  policy:        ['macro', 'rates'],
  sectoral:      ['equities'],
  commodities:   ['commodities'],
  geographic:    ['macro', 'em'],
  'cross-cutting': ['macro', 'equities'],
};

// Keyword → topic hints. When a theme's name OR keywords contain one
// of these tokens, the matching topic is appended to the seed.
const KEYWORD_TOPIC_HINTS = [
  { match: /copper/i,                            topic: 'copper' },
  { match: /gold|silver|precious/i,              topic: 'gold' },
  { match: /oil|gas|energy|crude|opec/i,         topic: 'oil-gas' },
  { match: /aluminum|aluminium/i,                topic: 'aluminum' },
  { match: /uranium|nuclear/i,                   topic: 'uranium' },
  { match: /bank|insurance|asset.manage|wealth/i, topic: 'financials' },
  { match: /real.estate|reit|property|housing/i, topic: 'real-estate' },
  { match: /software|saas|cloud|ai|tech/i,       topic: 'software' },
  { match: /short|fraud|activist/i,              topic: 'short-selling' },
  { match: /brazil|brazilian/i,                  topic: 'brazil' },
  { match: /emerging.market|EM\b/i,              topic: 'em' },
  { match: /minin?g|miner/i,                     topic: 'mining' },
  { match: /commodit/i,                          topic: 'commodities' },
];

export function topicsForTheme(theme) {
  if (!theme || typeof theme !== 'object') return [];
  const out = new Set(TYPE_TOPIC_SEEDS[theme.type] || []);
  // theme.keywords may be a legacy string array OR pill array
  // ({text, op}). Extract the text either way.
  const keywordsBlob = Array.isArray(theme.keywords)
    ? theme.keywords
        .map((k) =>
          typeof k === 'string'
            ? k
            : k && typeof k.text === 'string'
            ? k.text
            : ''
        )
        .join(' ')
    : '';
  const blob = [
    theme.name,
    keywordsBlob,
    Array.isArray(theme.countries) ? theme.countries.join(' ') : '',
  ].join(' ');
  for (const h of KEYWORD_TOPIC_HINTS) {
    if (h.match.test(blob)) out.add(h.topic);
  }
  return Array.from(out);
}

// Derive topics from a free-form query string. Used by /api/tweets when
// the request is for a theme or a Quick Look Up (no theme object on
// hand) — we keyword-sniff the constructed query for topic hints.
export function topicsForQuery(q) {
  if (!q || typeof q !== 'string') return [];
  const out = new Set();
  for (const h of KEYWORD_TOPIC_HINTS) {
    if (h.match.test(q)) out.add(h.topic);
  }
  return Array.from(out);
}

// Sector-ETF + index cashtags by topic. Used to expand X / Twitter
// advanced_search for commodity / sector themes — `$JJC` and `$COPX`
// surface tweets about copper that don't mention the word "copper"
// explicitly. Mirrors a common FinTwit shorthand.
const TOPIC_CASHTAGS = {
  copper:    ['$JJC', '$CPER', '$COPX'],
  gold:      ['$GLD', '$GDX', '$GDXJ', '$NUGT'],
  'oil-gas': ['$USO', '$XLE', '$XOP', '$OIH'],
  aluminum:  ['$JJU'],
  uranium:   ['$URA', '$URNM', '$URNJ'],
  mining:    ['$XME', '$PICK'],
  financials:['$XLF', '$KBE', '$KRE'],
  'real-estate': ['$XLRE', '$VNQ'],
  software:  ['$IGV', '$XLK'],
  em:        ['$EEM', '$VWO', '$EWZ'],
  brazil:    ['$EWZ', '$BRZU'],
};

// Hashtag forms by topic. Same expansion lever as cashtags but on the
// hash side — `#copperprice`, `#goldbugs` show up in different FinTwit
// circles than the cashtag posts.
const TOPIC_HASHTAGS = {
  copper:    ['#copper', '#copperprice'],
  gold:      ['#gold', '#goldbugs', '#goldprice'],
  'oil-gas': ['#OOTT', '#oilprice'],
  aluminum:  ['#aluminum', '#aluminium'],
  uranium:   ['#uranium', '#u3o8'],
  mining:    ['#mining'],
  brazil:    ['#brazil', '#brasil'],
};

export function cashtagsForTopics(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return [];
  const out = new Set();
  for (const t of topics) {
    for (const tag of TOPIC_CASHTAGS[t] || []) out.add(tag);
  }
  return Array.from(out);
}

export function hashtagsForTopics(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return [];
  const out = new Set();
  for (const t of topics) {
    for (const tag of TOPIC_HASHTAGS[t] || []) out.add(tag);
  }
  return Array.from(out);
}

// Look up FinTwit handles whose topic affinity overlaps with the
// requested topic set. Returns deduplicated handle list.
export function accountsForTopics(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return [];
  const wanted = new Set(topics);
  const out = [];
  for (const acc of FINTWIT_ACCOUNTS) {
    if (acc.topics.some((t) => wanted.has(t))) out.push(acc.handle);
  }
  return Array.from(new Set(out));
}
