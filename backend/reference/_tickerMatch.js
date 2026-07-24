// Shared ticker matcher.
//
// Used by:
//   - api/tweets.js — filter TwitterAPI.io advanced_search results to
//     ones that actually reference the holding (not just a name collision)
//   - api/independent-research.js — filter Twitter-account curated source
//     items down to the focus ticker / theme keyword set
//   - api/must-reads.js (via the stock-relevance gate) — drop Google News
//     hits that name-collide with the holding (e.g. an article about
//     aluminium that doesn't actually mention Century Aluminum)
//
// Matching rules
// ==============
//  - Name + alias substring match (case-insensitive). Aliases come from
//    TICKER_KEYWORDS in _independentSources.js plus any extra aliases
//    the caller hands in. Single-character / two-character keywords are
//    rejected up front because they false-positive on every body of text.
//  - Cashtag form: `$<TICKER_BASE>` with word boundary, case-insensitive.
//    `BN US` matches `$BN` anywhere.
//  - Canadian-listing suffix forms: `<TICKER_BASE>.<XX>` (with optional
//    `$` prefix) where `XX` is one of TO, V, NE, VN, CN. So `TGB CN`
//    matches `TGB.TO`, `$TGB.V`, `TGB.NE`, etc.
//  - Bare ticker symbols WITHOUT the `$` prefix are NOT matched. "BN"
//    alone in prose is too ambiguous (Bayer's Frankfurt code, a person's
//    initials, etc.). Cashtag is the disambiguated form on X / Twitter.
//
// Inputs
// ======
//   text     : the haystack — tweet body, headline, summary, article
//              snippet, anything textual.
//   ticker   : Bloomberg-style `BN US`, `TGB CN`, etc.
//   options  :
//     name          — full company name (e.g. "Brookfield Corp")
//                     Added to the alias list automatically.
//     extraAliases  — additional name forms to accept. Useful when a
//                     theme query wants to match an industry term too.

import { getKeywordsForTicker } from './_independentSources.js';

// Minimum length for substring aliases. Two-letter aliases match too
// much prose; three is the floor that excludes most accidents.
const MIN_ALIAS_LEN = 3;

// Yahoo-style suffixes for Canadian listings. The cashtag form is what
// X / FinTwit uses (`$TGB.TO`); the dotted form without `$` is what
// brokerage tickers / data providers use. We accept both.
const CN_SUFFIXES = ['TO', 'V', 'NE', 'VN', 'CN'];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBloomberg(ticker) {
  if (typeof ticker !== 'string') return null;
  const m = ticker.trim().match(/^([A-Z0-9]+)\s+(US|CN)$/i);
  if (!m) return null;
  return { base: m[1].toUpperCase(), exchange: m[2].toUpperCase() };
}

// True if `text` references the holding by name, alias, cashtag, or
// Yahoo-suffix form. Order of cheapness: alias substring → cashtag
// regex → Canadian suffix regex.
//
// Alias matching strategy:
//   - Short alphabetic aliases (≤ 5 chars, letters only — looks like
//     a bare ticker symbol or acronym): word-boundary regex.
//     "BAM" matches a tweet that says "BAM closed at $51" but NOT
//     one that says "Bambi opened in theaters". Prevents acronym
//     false positives that broke the Brookfield-vs-Bambi case.
//   - Long aliases (≥ 6 chars OR containing whitespace / punctuation):
//     plain substring match. "Brookfield" matches anywhere in the
//     haystack; word-boundary would over-tighten.
export function mentionsHolding(text, ticker, options = {}) {
  if (!text || typeof text !== 'string' || !ticker) return false;
  const lower = text.toLowerCase();

  const aliases = collectAliases(ticker, options);
  for (const a of aliases) {
    if (a.length < MIN_ALIAS_LEN) continue;
    if (/^[A-Za-z]{2,5}$/.test(a)) {
      const re = new RegExp(`\\b${escapeRegex(a)}\\b`, 'i');
      if (re.test(text)) return true;
    } else if (lower.includes(a.toLowerCase())) {
      return true;
    }
  }

  const parsed = parseBloomberg(ticker);
  if (!parsed) return false;
  const { base, exchange } = parsed;

  const cashRe = new RegExp(`\\$${escapeRegex(base)}\\b`, 'i');
  if (cashRe.test(text)) return true;

  if (exchange === 'CN') {
    const suffixGroup = CN_SUFFIXES.map(escapeRegex).join('|');
    const suffixRe = new RegExp(
      `\\$?${escapeRegex(base)}\\.(?:${suffixGroup})\\b`,
      'i'
    );
    if (suffixRe.test(text)) return true;
  }

  return false;
}

// Combine the holding's keyword list (from _independentSources.js) with
// any caller-supplied extras. Deduped, leading/trailing whitespace
// trimmed, kept in original case for display use (only lower-cased at
// match time).
export function collectAliases(ticker, options = {}) {
  const out = new Set();
  if (options.name && typeof options.name === 'string') out.add(options.name.trim());
  for (const k of getKeywordsForTicker(ticker)) {
    if (typeof k === 'string' && k.trim()) out.add(k.trim());
  }
  if (Array.isArray(options.extraAliases)) {
    for (const k of options.extraAliases) {
      if (typeof k === 'string' && k.trim()) out.add(k.trim());
    }
  }
  return Array.from(out);
}

// Returns search tokens to feed into a third-party search API (e.g.
// TwitterAPI.io advanced_search OR Google News) when you want every
// document that mentions the holding regardless of which form the
// author used. Excludes overly generic aliases (length < MIN_ALIAS_LEN)
// to keep query length manageable.
export function tickerSearchTokens(ticker, options = {}) {
  const tokens = new Set();
  for (const a of collectAliases(ticker, options)) {
    if (a.length >= MIN_ALIAS_LEN) tokens.add(a);
  }
  const parsed = parseBloomberg(ticker);
  if (parsed) {
    tokens.add(`$${parsed.base}`);
    if (parsed.exchange === 'CN') {
      for (const sfx of CN_SUFFIXES) {
        tokens.add(`${parsed.base}.${sfx}`);
      }
    }
  }
  return Array.from(tokens);
}
