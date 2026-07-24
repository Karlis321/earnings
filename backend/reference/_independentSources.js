// Per-publication registry of INDEPENDENT-research feeds — Substack, Beehiiv,
// Ghost, Medium, and standalone analyst blogs.
//
// File is prefixed with `_` so Vercel does NOT expose it as an HTTP endpoint.
//
// Architecture
// ============
// Unlike `_officialSources.js` (keyed by ticker), this registry is keyed by
// PUBLICATION, because most independent newsletters cover many holdings.
// Per-ticker relevance is decided at fetch time by keyword-matching the post
// titles and HTML descriptions against a per-ticker keyword list.
//
//   PUBLICATIONS    — { id, name, url, platform, topics }
//   TICKER_KEYWORDS — { 'BN US': ['Brookfield', 'Bruce Flatt', ...] }
//
// Source shape (per publication):
//   {
//     id:        string                // stable slug used in dedup keys
//     name:      string                // human-readable label
//     url:       string                // RSS / Atom feed URL
//     platform:  'substack' | 'beehiiv' | 'ghost' | 'medium' | 'blog'
//     topics:    string[]              // informational, no filtering yet
//   }
//
// SEED LIST — URLs verified live 2026-05-29 (HTTP 200, valid RSS, 7–20 items
// per feed). Several Substacks have migrated to custom domains; the canonical
// URLs are used directly to avoid a redirect hop on every fetch. Dead feeds
// fail soft (the parser returns [] and the UI shows an empty list — they do
// not break sibling publications).

export const PUBLICATIONS = [
  {
    id: 'doomberg',
    name: 'Doomberg',
    url: 'https://newsletter.doomberg.com/feed',
    platform: 'substack',
    topics: ['energy', 'commodities', 'copper', 'aluminum', 'gold', 'mining', 'macro'],
  },
  {
    id: 'net-interest',
    name: 'Net Interest',
    url: 'https://www.netinterest.co/feed',
    platform: 'substack',
    topics: ['financials', 'banking', 'alts'],
  },
  {
    id: 'the-bear-cave',
    name: 'The Bear Cave',
    url: 'https://thebearcave.substack.com/feed',
    platform: 'substack',
    topics: ['short-selling', 'governance'],
  },
  {
    id: 'mbi-deep-dives',
    name: 'MBI Deep Dives',
    url: 'https://mbideepdives.substack.com/feed',
    platform: 'substack',
    topics: ['tech', 'software', 'financials'],
  },
  {
    id: 'last-bear-standing',
    name: 'The Last Bear Standing',
    url: 'https://www.thelastbearstanding.com/feed',
    platform: 'substack',
    topics: ['macro', 'financials'],
  },
  {
    id: 'apricitas',
    name: 'Apricitas Economics',
    url: 'https://www.apricitas.io/feed',
    platform: 'substack',
    topics: ['macro', 'financials'],
  },
  {
    id: 'concoda',
    name: 'Concoda',
    url: 'https://www.conks.plumbing/feed',
    platform: 'substack',
    topics: ['macro', 'financials'],
  },
  {
    id: 'quoth-the-raven',
    name: 'Quoth the Raven',
    url: 'https://quoththeraven.substack.com/feed',
    platform: 'substack',
    topics: ['short-selling', 'mining', 'small-caps', 'macro'],
  },
  {
    id: 'libertys-highlights',
    name: "Liberty's Highlights",
    url: 'https://www.libertyrpf.com/feed',
    platform: 'substack',
    topics: ['investing', 'tech', 'financials'],
  },
  {
    id: 'emerging-moats',
    name: 'Emerging Moats (Chit Chat Money)',
    url: 'https://www.emergingmoats.com/feed',
    platform: 'substack',
    topics: ['small-caps', 'tech', 'software', 'financials'],
  },
  {
    id: 'yet-another-value-blog',
    name: 'Yet Another Value Blog',
    url: 'https://www.yetanothervalueblog.com/feed',
    platform: 'substack',
    topics: ['value', 'special-situations', 'small-caps'],
  },
  {
    id: 'hfi-research',
    name: 'HFI Research',
    url: 'https://www.hfir.com/feed',
    platform: 'substack',
    topics: ['oil-gas', 'energy', 'commodities'],
  },
  {
    id: 'credit-strategist',
    name: 'The Credit Strategist',
    url: 'https://www.thecreditstrategist.com/feed',
    platform: 'substack',
    topics: ['credit', 'macro', 'financials'],
  },
  {
    id: 'felder-report',
    name: 'The Felder Report',
    url: 'https://thefelderreport.com/feed/',
    platform: 'blog',
    topics: ['macro', 'markets', 'gold'],
  },
  // Mining trade press — high-cadence, headline names the company directly.
  // No <content:encoded> but the title alone is enough for keyword matching.
  // These are our best shot at coverage for the small-cap miners (HBM, CS,
  // TGB, WRN, SCMI, DBG) and the aluminum/energy holdings (CENX, SHLE).
  {
    id: 'northern-miner',
    name: 'The Northern Miner',
    url: 'https://www.northernminer.com/feed/',
    platform: 'trade-press',
    topics: ['mining', 'copper', 'gold', 'aluminum', 'commodities'],
  },
  {
    id: 'mining-com',
    name: 'Mining.com',
    url: 'https://www.mining.com/feed/',
    platform: 'trade-press',
    topics: ['mining', 'copper', 'gold', 'aluminum', 'lithium', 'commodities'],
  },
  // Broad macro/RE/financials — good for Brookfield exposure.
  {
    id: 'wolf-street',
    name: 'Wolf Street',
    url: 'https://wolfstreet.com/feed/',
    platform: 'blog',
    topics: ['macro', 'financials', 'real-estate'],
  },
  // The Deep Dive — Canadian small-cap focus (TSX/TSXV). Best chance of
  // catching the Canadian holdings (CS CN, TGB CN, ABXX CN, SHLE CN, TNZ CN,
  // VLE CN, DBG CN, SCMI CN, TOI CN). URL not verifiable from the build host
  // due to DNS, but the publication is well-known; fetch fails soft if dead.
  {
    id: 'the-deep-dive',
    name: 'The Deep Dive',
    url: 'https://thedeepdiveca.com/feed/',
    platform: 'blog',
    topics: ['small-caps', 'canada', 'mining', 'tech'],
  },
];

// Keywords per Bloomberg ticker. Case-insensitive substring match against the
// post title + description.
//
// Derived from the canonical entity registry at data/entity-registry.json
// via api/_entityRegistry.js getAliases — single source of truth. The
// registry's aliases include the legalName, displayName, Bloomberg
// ticker, and any sector-specific aliases (project names, executive
// names, alternate name forms).
//
// Important curation rules (preserved in the registry — see
// data/entity-registry.json):
//   - "B3" alone matches Boeing-737 prose; the registry uses "B3 SA" /
//     "B3 Brasil" / "B3 S.A." / "Bolsa Brasil" / "B3SA3" instead.
//   - "Hat" alone substrings into "what/that"; the registry uses
//     "Hat copper-gold" / "Hat polymetallic" for Doubleview.
//   - Constellation Software / CSU.TO is included for TOI CN because
//     commentary on the parent (MBI Deep Dives etc.) is materially
//     relevant to Topicus investors.
//
// Includes only core holdings (isCore=true). Watchlist additions
// previously returned [] from getKeywordsForTicker; with the registry
// they get aliases too — this is the structural fix for the audit's
// "HOYA has no keyword coverage" open issue.
import { getAllEntities, getAliases } from './_entityRegistry.js';

export const TICKER_KEYWORDS = (() => {
  const out = {};
  for (const e of getAllEntities()) {
    if (e && typeof e.ticker === 'string') {
      out[e.ticker] = getAliases(e.ticker);
    }
  }
  return out;
})();

export function getKeywordsForTicker(bloombergTicker) {
  return TICKER_KEYWORDS[bloombergTicker] || [];
}

// True if `text` matches any of `keywords`. Each keyword is checked in
// two passes:
//   1. Literal substring (case-insensitive) — fastest, no false positives.
//   2. Multi-word fallback — for keywords like "Brazil interest rates"
//      where the literal phrase rarely appears in Substack bodies that
//      paraphrase ("Brazil's central bank raised rates"). Requires every
//      word of the keyword (length >= 3) to appear in the text within
//      a 400-character window, so unrelated coincidences are unlikely.
//
// The fallback was added because theme pages were returning 0 items
// when the analyst entered specific multi-word phrases — built-in
// Substacks DO cover the topic but never use the analyst's exact
// phrasing in the title/body text we keyword-match against.
export function matchesAnyKeyword(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => {
    const k = (kw || '').toLowerCase().trim();
    if (!k) return false;
    if (lower.includes(k)) return true;
    const words = k.split(/\s+/).filter((w) => w.length >= 3);
    if (words.length < 2) return false;
    return allWordsWithinWindow(lower, words, 400);
  });
}

// Anchor on the first word, scan every occurrence, accept if all
// remaining words also appear within `windowChars` on either side.
// Catches co-occurrences in long bodies where a topic is mentioned
// multiple times but the FIRST occurrence of one word is far from the
// first occurrence of another.
function allWordsWithinWindow(lower, words, windowChars) {
  const [anchor, ...rest] = words;
  let pos = lower.indexOf(anchor);
  while (pos >= 0) {
    const start = Math.max(0, pos - windowChars);
    const end = pos + anchor.length + windowChars;
    const segment = lower.slice(start, end);
    if (rest.every((w) => segment.includes(w))) return true;
    pos = lower.indexOf(anchor, pos + 1);
  }
  return false;
}
