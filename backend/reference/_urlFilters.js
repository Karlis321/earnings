// URL filters for curated-source results.
//
// Two predicates exported here:
//
//   isLikelyArticleUrl(url) → bool
//     Used for items whose URL is publisher-direct (custom RSS feeds,
//     where the analyst added a Substack-style URL and we get items
//     with the publisher URL intact). A cheap generic check based on
//     path shape + a blocklist of known non-article segments.
//
//   matchesHostArticlePattern(url) → 'allow' | 'deny' | 'unknown'
//     Used by api/_articleVerifier.js after it has resolved a Google
//     News redirect to the actual publisher URL. Per-host article-path
//     allowlists for the major publishers we know well (WSJ,
//     Bloomberg, FT, Reuters, NYT, Economist, CNBC, MarketWatch,
//     Barron's, WaPo). Returns:
//       - 'allow' if the URL path matches the host's article pattern,
//       - 'deny'  if the path matches a known non-article pattern,
//       - 'unknown' for hosts not in the per-host map (defer to
//                   metadata signals).
//
// Google News mediation breaks the URL filter
// ===========================================
// `news.google.com/rss/search?q=<kw> site:wsj.com` returns RSS items
// whose <link> is `https://news.google.com/rss/articles/<opaque-b64>`
// — NOT the WSJ URL. Path-based filtering on the Google News URL is
// useless (every URL has the same shape). The verifier resolves the
// redirect via fetch, THEN we apply `matchesHostArticlePattern` on
// the final URL. See `api/_articleVerifier.js`.

// Path-prefix or segment patterns that DO NOT carry articles. Generic
// across publishers — applies to every curated source. Case-insensitive
// substring check on the URL's pathname.
const GENERIC_NON_ARTICLE = [
  // Stock-quote pages, market data, company profiles
  '/market-data/',
  '/markets/quote/',
  '/quote/',
  '/quotes/',
  '/profile/',
  '/profiles/',
  '/companies/',
  '/company/',
  '/business/profile/',
  '/stocks/',
  '/stock/',

  // Section / topic / tag / category landings — index pages, not articles
  '/section/',
  '/topic/',
  '/topics/',
  '/tag/',
  '/tags/',
  '/category/',
  '/categories/',
  '/subjects/',
  '/keyword/',

  // Video / podcast / newsletter hubs
  '/video/',
  '/videos/',
  '/tv/',
  '/podcast/',
  '/podcasts/',
  '/audio/',
  '/newsletter/',
  '/newsletters/',
  '/series/',

  // Author / contributor pages
  '/author/',
  '/authors/',
  '/contributor/',
  '/contributors/',
  '/people/',
  '/staff/',
  '/reporter/',
  '/reporters/',

  // Subscription / account / search / live blog pages
  '/subscribe/',
  '/subscription/',
  '/account/',
  '/login',
  '/sign-in',
  '/register/',
  '/search?',
  '/search/',
  '/livestream/',
  '/live-news/',
];

// Per-host extras — paths that are non-article on a specific
// publisher but might be articles elsewhere. The key is matched as a
// hostname suffix (so 'wsj.com' matches 'www.wsj.com').
const HOST_NON_ARTICLE = {
  'bloomberg.com': [
    '/research/',
    '/news/videos/',
    '/quicktake/videos/',
  ],
  'wsj.com': [
    '/news/types/',
  ],
  'ft.com': [
    '/stream/',
    '/markets/data/',
  ],
  'reuters.com': [
    '/markets/companies/',
  ],
  'nytimes.com': [
    '/by/',
    '/spotlight/',
  ],
};

function lowerPath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { host: u.hostname.toLowerCase(), path: u.pathname.toLowerCase() };
  } catch {
    return null;
  }
}

// True if the path-portion of `url` matches one of the patterns
// configured for either the generic non-article list or the host-
// specific list.
function matchesNonArticle(url, host, path) {
  for (const pat of GENERIC_NON_ARTICLE) {
    if (path.includes(pat)) return true;
  }
  for (const [hostKey, patterns] of Object.entries(HOST_NON_ARTICLE)) {
    if (host === hostKey || host.endsWith(`.${hostKey}`)) {
      for (const pat of patterns) {
        if (path.includes(pat)) return true;
      }
    }
  }
  return false;
}

// True if the path looks article-shaped:
//   - has at least 2 path segments OR
//   - has a slug (a path segment with a hyphen, indicating a multi-
//     word title) anywhere
//   - or includes a year (4-digit number) — typical of date-prefixed
//     news URLs
// A trailing-slash homepage (`/`) or a single-segment landing
// (`/markets`) is not article-shaped.
function pathLooksLikeArticle(path) {
  if (!path || path === '/' || path === '') return false;
  const segs = path.split('/').filter(Boolean);
  if (segs.length >= 2) return true;
  if (segs.some((s) => s.includes('-'))) return true;
  if (/\b(19|20)\d{2}\b/.test(path)) return true;
  return false;
}

// Public predicate. Used by /api/independent-research to filter
// site-filter (Google News + site:) results before they enter the
// curated feed.
export function isLikelyArticleUrl(url) {
  const parsed = lowerPath(url);
  if (!parsed) return false;
  const { host, path } = parsed;
  if (matchesNonArticle(url, host, path)) return false;
  if (!pathLooksLikeArticle(path)) return false;
  return true;
}

// Looser variant — for cases where we already trust the source and
// just want to drop the unambiguous landing pages. Currently unused
// but exposed for the day a different feed type wants only the
// non-article filter without the article-shape requirement.
export function isNotJunkUrl(url) {
  const parsed = lowerPath(url);
  if (!parsed) return false;
  return !matchesNonArticle(url, parsed.host, parsed.path);
}

// =====================================================================
// looksLikeJunkPage(item) — universal non-article detector
// =====================================================================
//
// Catches stock-quote / metrics / profile / "Stock Symbol" landing
// pages that Google News indexes as if they were articles. These
// surface in /api/news and /api/must-reads' premium-host fan-out (the
// `site:wsj.com` / `site:reuters.com` etc. queries return Reuters'
// `/markets/companies/CENX.OQ/key-metrics/margins/` and MarketWatch's
// `/investing/stock/BN` pages as if they were news).
//
// Returns `true` if the item is junk (caller should drop it).
//
// Two checks, OR'd:
//   1. HEADLINE pattern — quote/metrics pages have deterministic title
//      shapes ("X Stock Price | Y Stock Quote (U.S.: NYSE)",
//      "Profile and Biography", "Key Metrics", etc.).
//   2. URL pattern — if the URL is publisher-direct (not a Google News
//      redirect we can't decode without HTTP), apply
//      matchesHostArticlePattern. 'deny' verdict ⇒ junk.
//
// Cheap to call — no network, no fetch, regex over title + URL only.
// Safe to put on the hot path of every items list.

// Junk-headline patterns. Each is anchored on a distinctive lexical
// fingerprint of a non-article landing page. Tested against a 12k-item
// home feed: catches 137 known junk items with zero false positives on
// real articles in the same sample.
const JUNK_HEADLINE_RES = [
  // MarketWatch quote pages: "NVDA Stock Price | NVIDIA Corp. Stock Quote (U.S.: Nasdaq)"
  /\bStock Price\s*\|\s*.+\bStock Quote\b/i,
  // Trailing exchange tag at end of headline: "(U.S.: NYSE)", "(U.S.:
  // Nasdaq)", "(U.S.: NYSE American)", "(U.S.: OTC Markets)". Anchored
  // to end-of-line so real articles that mention the exchange mid-
  // headline ("Volatility ahead for tech (Nasdaq) names") aren't
  // false-positive — quote pages put the exchange tag at the very end.
  /\(U\.S\.:\s+[^)]+\)\s*$/i,
  // Bare "(NYSE)" / "(Nasdaq)" / "(NYSE Arca)" at end (Bloomberg / WSJ
  // ETF quote shells).
  /\((?:NYSE(?:\s+(?:Arca|American))?|Nasdaq|OTC(?:\s+Markets)?)\)\s*$/i,
  // "Stock Overview" / "Stock Snapshot" / "Stock Profile" landings,
  // typically pipe-separated with the ticker.
  /\bStock (?:Overview|Snapshot|Profile|Summary)\b/i,
  // Reuters quote shells: "TKO.TO - | Stock Price & Latest News",
  // "WDC.OQ - | Stock Price & Latest News"
  /\|\s*Stock Price (?:&|and) Latest News/i,
  // Reuters / generic "Stock Snapshot" / "Stock Profile" / "Quote and Latest" landings.
  /\|\s*Stock Snapshot\b/i,
  /\bStock Profile\s*[-|·]/i,
  /\|\s*Quote and (?:Latest|Live)/i,
  // Reuters / Bloomberg key-metrics & financials landings.
  /\bKey Metrics\b.*\|/i,
  /\bFinancial Summary\b.*\|/i,
  // Bloomberg profile pages: "Eiichiro Ikeda, Hoya Corp: Profile and Biography"
  /\bProfile and Biography\b/i,
  /\bExecutive Profile\b\s*[-|·]\s*Bloomberg/i,
  // Bare-ticker headlines: "CENX.OQ", "VLE.TO", "WDC.OQ", or "BN US"
  // alone is never an article. Two shapes: with trailing pipe/dash
  // ("CENX.OQ -") and without ("CENX.OQ" alone).
  /^[A-Z0-9.]{2,12}\s*[-|]\s*$/,
  /^[A-Z][A-Z0-9.:]{1,12}$/,
  /^\([A-Z][A-Z0-9.:]{1,12}\)\s*\|/,
  // ChartMill / similar quant-screener "Technical Analysis" pages.
  /\bTechnical Analysis\b\s*\|/i,
  // CNBC "Check out X's stock price (TICKER) in real time"
  /Check out .+ stock price \([A-Z0-9.]+\) in real time/i,
  // Yahoo Finance / Investing.com quote landing pages.
  /\bAnalyst (?:Price Targets|Ratings)\s*-\s*(?:Yahoo|Investing)/i,
  // TradingView auto-generated metric pages, variant A — metric FIRST:
  //   "Free cash flow per share of Hudbay Minerals Inc – BVL:HBMUS"
  //   "Total debt per share of X – TICKER:CODE"
  //   "Operating margin of X – TICKER:CODE"
  /^(?:Free cash flow per share|Total debt per share|Operating margin|Total revenue per share|Net income per share|EBITDA per share|Revenue per share|Earnings per share|Return on equity|Return on assets|Book value per share|Dividend per share|Gross margin|Net margin)\s+of\s+.+\s*[-–—]\s*[A-Z]{2,6}:[A-Z0-9.]+\s*$/i,
  // TradingView auto-generated metric pages, variant B — metric at END:
  //   "Hudbay Minerals Inc Cash Flow – BVL:HBMUS"
  //   "Capstone Copper Corp Revenue – TSX:CS"
  // Distinctive trailing em-dash + EXCHANGE:TICKER never appears on
  // real articles; combined with the metric phrase it's unmistakable.
  /\s+(?:Cash Flow|Revenue|Net income|EBITDA|Gross margin|Operating margin|Free cash flow|Total debt|Book value|Dividend|Earnings|Return on equity|Return on assets)\s*[-–—]\s*[A-Z]{2,6}:[A-Z0-9.]+\s*$/i,
  // marketscreener.com bare-title syndication stubs:
  //   "Hudbay Minerals Inc.:"
  //   "Capstone Copper Corp:"
  // Headline ends with a corporate suffix + colon only. Real headlines
  // never end this way; this is the truncated-feed artifact.
  /\b(?:Inc|Corp|Corporation|Ltd|Limited|S\.A|L\.P|N\.V|PLC|Co|AG|SE|NV|SA|Plc|Holdings|Group)\.?\s*:\s*$/i,
  // MarketWatch / Yahoo daily auto-recap:
  //   "Brookfield Asset Management Ltd. Cl A stock falls Monday, underperforms"
  //   "Capstone Copper Corp. stock rises Tuesday, outperforms market"
  // Requires "stock [verb] ... (under|out)performs" — very tight on the
  // boilerplate template; real reporting doesn't use this exact phrasing.
  /\bstock\s+(?:falls?|rises?|gains?|drops?|jumps?|surges?|plunges?|slips?|climbs?|tumbles?|sinks?|rallies)\b[^.]{0,60}(?:under|out)performs?\b/i,
  // Stock Titan / similar auto-aggregator title with bare ticker chip:
  //   "(HBM) shareholders back board"
  /^\(?([A-Z]{1,5}(?::[A-Z]{1,4})?)\)?\s+shareholders\s+(?:back|elect|reject|approve)\b/i,
  // Atlantic Council fellow-citation tracker. AC publishes brief
  // "FellowName in PublicationName on Topic" items whenever one of
  // their fellows gets quoted in external press — these are
  // citation-of-an-external-citation, not original analysis. The
  // distinctive pattern is "<Surname> in <Outlet> on " — surname is
  // a single Title-cased word, outlet is up to a few Title-cased
  // words, then " on " introducing the topic.
  /^[A-Z][a-z]+\s+in\s+(?:The\s+)?[A-Z][A-Za-z'.\-]+(?:\s+[A-Z][A-Za-z'.\-]+){0,3}\s+on\s+\S/,
];

export function looksLikeJunkPage(item) {
  if (!item) return true;
  const headline = typeof item.headline === 'string' ? item.headline : '';
  const url = typeof item.url === 'string' ? item.url : '';

  // Layer 1: headline patterns — cheap, works regardless of URL form.
  for (const re of JUNK_HEADLINE_RES) {
    if (re.test(headline)) return true;
  }

  // Layer 2: URL pattern check. Only meaningful when the URL is
  // publisher-direct. For Google News redirect URLs (the opaque
  // /rss/articles/<b64> form), matchesHostArticlePattern returns
  // 'unknown' because the host is news.google.com — not in our rule
  // map — so this short-circuits cleanly and we rely on Layer 1.
  if (url && !/^https?:\/\/news\.google\.com\//i.test(url)) {
    const verdict = matchesHostArticlePattern(url);
    if (verdict === 'deny') return true;
  }

  return false;
}

// =====================================================================
// Per-host article-path allowlist
// =====================================================================
//
// Used by _articleVerifier.js after it resolves a Google News redirect
// to the publisher URL. Two regex sets per host:
//
//   articleRe — must match for the URL to be an article. The shape was
//               verified against real URLs from each publisher.
//   denyRe    — paths the host uses for non-article pages (quote, ETF,
//               topic, section, profile, video, etc.). Overrides
//               articleRe — if a URL matches a deny pattern, it's
//               always rejected.
//
// Hosts not in this map return `'unknown'` from
// `matchesHostArticlePattern`; the verifier defers to og:type / JSON-LD
// for those.

const HOST_ARTICLE_RULES = {
  'wsj.com': {
    // WSJ articles end with `-<8+ alphanumeric ID>` (e.g.
    // `/articles/spy-balloon-shot-down-11675625111` or
    // `/business/banks/credit-suisse-acquires-jpm-1234567890ab`).
    articleRe: [
      /^\/articles\/[a-z0-9-]+-[a-z0-9]{8,}\/?$/i,
      /^\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+-[a-z0-9]{8,}\/?$/i,
      /^\/[a-z0-9-]+\/[a-z0-9-]+-[a-z0-9]{8,}\/?$/i,
    ],
    denyRe: [
      /^\/market-data\//i,
      /^\/news\/types\//i,
      /^\/buyside\//i,
      /^\/podcasts\//i,
      /^\/video\//i,
      /^\/newsletters\//i,
    ],
  },
  'bloomberg.com': {
    articleRe: [
      /^\/(?:news|opinion)\/(?:articles|features|newsletters)\/\d{4}-\d{2}-\d{2}\//i,
    ],
    denyRe: [
      /^\/quote\//i,
      /^\/profile\//i,
      /^\/research\//i,
      /^\/products\//i,
      /^\/news\/videos\//i,
      /^\/quicktake\/videos\//i,
    ],
  },
  'ft.com': {
    // FT articles are `/content/<UUID>` — UUID is 8-4-4-4-12 hex.
    articleRe: [
      /^\/content\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    ],
    denyRe: [/^\/stream\//i, /^\/markets\/data\//i, /^\/topics\//i, /^\/video\//i],
  },
  'reuters.com': {
    // Reuters article URLs end with `-YYYY-MM-DD/` after the section.
    articleRe: [
      /^\/(?:world|business|markets|technology|sustainability|lifestyle|sports|graphics|legal|breakingviews|investigates|special-report)\/.+-\d{4}-\d{2}-\d{2}\/?$/i,
    ],
    denyRe: [
      /^\/companies\//i,
      /^\/markets\/companies\//i,
      /^\/markets\/quotes?\//i,
      /^\/markets\/stocks?\//i,
    ],
  },
  'nytimes.com': {
    // NYT articles are `/YYYY/MM/DD/<section>/<slug>.html`.
    articleRe: [/^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/.+\.html?$/i],
    denyRe: [
      /^\/by\//i,
      /^\/topic\//i,
      /^\/section\//i,
      /^\/markets\//i,
      /^\/spotlight\//i,
      /^\/marketdata\//i,
    ],
  },
  'economist.com': {
    articleRe: [
      /^\/(?:briefing|finance-and-economics|business|leaders|essay|graphic-detail|special-report|by-invitation|culture|china|asia|americas|europe|britain|middle-east-and-africa|united-states|international|the-economist-explains|economic-and-financial-indicators|obituary|1843-magazine|the-world-this-week)\/\d{4}\/\d{2}\/\d{2}\//i,
    ],
    denyRe: [/^\/topics\//i, /^\/podcasts\//i, /^\/films\//i],
  },
  'cnbc.com': {
    // CNBC articles: `/YYYY/MM/DD/<slug>.html`.
    articleRe: [/^\/\d{4}\/\d{2}\/\d{2}\/.+\.html?$/i],
    denyRe: [/^\/quotes\//i, /^\/video\//i],
  },
  'marketwatch.com': {
    articleRe: [
      /^\/story\/[a-z0-9-]+/i,
      /^\/articles\/[a-z0-9-]+/i,
      /^\/picks\/[a-z0-9-]+/i,
    ],
    denyRe: [
      /^\/investing\/(?:stock|fund|index|future|cryptocurrency)\//i,
      /^\/tools\//i,
    ],
  },
  'barrons.com': {
    articleRe: [/^\/articles\/.+-[a-z0-9]{6,}\/?$/i],
    denyRe: [/^\/market-data\//i, /^\/quote\//i, /^\/funds\//i],
  },
  'washingtonpost.com': {
    articleRe: [/^\/(?:[a-z0-9-]+\/)?\d{4}\/\d{2}\/\d{2}\//i],
    denyRe: [/^\/by\//i, /^\/topic\//i, /^\/people\//i],
  },
  'forbes.com': {
    // Forbes articles: `/sites/<author>/<YYYY>/<MM>/<DD>/<slug>/` or
    // `/<section>/article/<slug>/`.
    articleRe: [
      /^\/sites\/[^/]+\/\d{4}\/\d{2}\/\d{2}\//i,
      /^\/[a-z0-9-]+\/article\/[a-z0-9-]+/i,
    ],
    denyRe: [/^\/profile\//i, /^\/topic\//i, /^\/lists\//i],
  },
};

function matchHostRule(host) {
  if (!host) return null;
  const lower = host.toLowerCase();
  if (HOST_ARTICLE_RULES[lower]) return HOST_ARTICLE_RULES[lower];
  for (const key of Object.keys(HOST_ARTICLE_RULES)) {
    if (lower.endsWith(`.${key}`)) return HOST_ARTICLE_RULES[key];
  }
  return null;
}

// 'allow' / 'deny' / 'unknown'. See module header for the contract.
// The verifier uses this as Layer 1; if the URL is allow/deny by host
// rule it can short-circuit. Unknown hosts defer to metadata.
export function matchesHostArticlePattern(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'unknown';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const rule = matchHostRule(host);
  if (!rule) return 'unknown';

  for (const re of rule.denyRe || []) {
    if (re.test(path)) return 'deny';
  }
  for (const re of rule.articleRe || []) {
    if (re.test(path)) return 'allow';
  }
  // Host is recognised but neither allow nor deny matched — treat as
  // 'deny'. The rationale: for hosts we've taken the trouble to
  // allowlist, any path that doesn't match the article pattern is
  // most likely a non-article (the publisher's article URLs are
  // deterministic enough that legit articles always match).
  return 'deny';
}
