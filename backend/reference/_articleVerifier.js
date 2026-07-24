// Article verifier.
//
// Curated-source fetches that go through Google News (the `site:<host>`
// path used for major publishers like wsj.com, ft.com, bloomberg.com,
// nytimes.com, reuters.com, ...) return RSS items whose <link> is a
// `https://news.google.com/rss/articles/<opaque-base64>` redirect URL,
// NOT the publisher URL. That means a URL-pattern filter can never
// distinguish a real article from a stock-quote / ETF / topic page —
// every Google News URL has the same shape.
//
// This module resolves each Google News redirect to the publisher URL
// and verifies the result is an actual article via:
//
//   1. URL allowlist for the FINAL (post-redirect) URL — per-host
//      patterns in api/_urlFilters.js's `matchesHostArticlePattern`.
//      Cheap deterministic check.
//   2. Page metadata — og:type / Twitter card / JSON-LD schema. The
//      <head> usually fits in the first ~30 KB so we Range-request to
//      avoid pulling the whole article body.
//
// Items must pass BOTH layers. Verification results are cached by the
// original URL in an in-memory Map; the cache survives Vercel's warm
// function lifetime (~minutes between requests).
//
// Concurrency is capped at 8 to keep total fetch time bounded — a
// typical curated-source fetch has 20-40 candidate URLs which then
// completes in ~1-3 s total.

import { matchesHostArticlePattern } from './_urlFilters.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Cache TTL — verifications are stable for 24h. Publishers rarely change
// a URL's article-vs-page nature within a day.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Read at most this many bytes of the response body. <head> usually
// lives well within the first 30 KB; the full article body is much
// larger but we don't need it.
const MAX_BODY_BYTES = 30000;

// Per-request fetch timeout. Slow publishers exist (FT in particular)
// — if we wait 30 s for one URL we starve the parallel pool.
const FETCH_TIMEOUT_MS = 6000;

// Concurrency cap on the parallel pool.
const MAX_CONCURRENT = 8;

const cache = new Map();

function readCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return v;
}

function writeCache(key, value) {
  cache.set(key, { ...value, ts: Date.now() });
}

// =====================================================================
// Public API
// =====================================================================

// Verifies that `url` resolves to a real article. Returns
// `{ ok: boolean, finalUrl: string | null, reason?: string }`. The
// `finalUrl` is the post-redirect publisher URL — callers should
// substitute it in place of the original Google News redirect so a
// click goes direct to the article.
export async function verifyArticleUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, finalUrl: null, reason: 'no-url' };

  const cached = readCache(url);
  if (cached) return { ok: cached.ok, finalUrl: cached.finalUrl, reason: cached.reason };

  const result = await fetchAndVerify(url);
  writeCache(url, result);
  return result;
}

// Batch helper — accepts an array of URLs, runs them with the
// concurrency cap, returns an array of results aligned with the input
// order. Caller can map back to the original items by index.
export async function verifyArticleUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  const results = new Array(urls.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, urls.length) }, async () => {
    while (cursor < urls.length) {
      const i = cursor++;
      results[i] = await verifyArticleUrl(urls[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// =====================================================================
// Internals
// =====================================================================

async function fetchAndVerify(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { ...BROWSER_HEADERS, Range: `bytes=0-${MAX_BODY_BYTES}` },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // Network error — fall back to URL pattern alone. We can't
    // resolve the redirect; check the original URL (if it's a Google
    // News URL we'll get 'unknown' and reject).
    const verdict = matchesHostArticlePattern(url);
    if (verdict === 'allow') {
      return { ok: true, finalUrl: url, reason: `fetch-err-url-allow:${e.name || 'err'}` };
    }
    return { ok: false, finalUrl: null, reason: `fetch-err:${e.name || 'err'}` };
  }
  clearTimeout(timer);

  const finalUrl = response.url || url;

  // 4xx / 5xx after redirects — usually a paywall (WSJ, FT, etc.
  // sometimes 401/403 anonymous requests) or a true dead link.
  // Fall back to the per-host URL pattern: if the resolved URL
  // matches a known publisher's article path, trust the URL and
  // accept; otherwise reject.
  if (!response.ok && response.status !== 206) {
    const verdict = matchesHostArticlePattern(finalUrl);
    if (verdict === 'allow') {
      return { ok: true, finalUrl, reason: `http-${response.status}-url-allow` };
    }
    return { ok: false, finalUrl, reason: `http-${response.status}` };
  }

  // Layer 1: URL pattern check on the RESOLVED URL.
  // matchesHostArticlePattern returns one of:
  //   'allow'   — the URL matches the host's article path pattern
  //   'deny'    — the URL matches a non-article pattern for that host
  //   'unknown' — host has no specific rule; defer to metadata
  const urlVerdict = matchesHostArticlePattern(finalUrl);
  if (urlVerdict === 'deny') {
    return { ok: false, finalUrl, reason: 'url-pattern-deny' };
  }

  // Layer 2: parse the HTML head for og:type / JSON-LD.
  let body;
  try {
    body = await response.text();
  } catch {
    // If we can't read the body, fall back to whatever the URL pattern
    // said. Allowlisted URLs survive; unknown / denied do not.
    return {
      ok: urlVerdict === 'allow',
      finalUrl,
      reason: urlVerdict === 'allow' ? 'body-unreadable-allow' : 'body-unreadable',
    };
  }
  const head = body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body;
  const meta = parseArticleSignals(head);

  if (meta.negative) {
    // og:type explicitly says this is NOT an article (e.g. website,
    // profile). Reject even if URL pattern would allow.
    return { ok: false, finalUrl, reason: `og-type:${meta.negative}` };
  }
  if (meta.positive) {
    // og:type=article OR JSON-LD NewsArticle / Article — accept,
    // regardless of URL pattern (URL pattern is a hint, metadata is
    // ground truth).
    return { ok: true, finalUrl, reason: `og:${meta.positive}` };
  }

  // No clear meta signal. Fall back to URL pattern verdict.
  if (urlVerdict === 'allow') {
    return { ok: true, finalUrl, reason: 'url-allow-no-meta' };
  }
  // unknown host + no positive meta = ambiguous. Accept conservatively
  // — better to surface a borderline article than to silently drop
  // legitimate content from a small publisher we haven't allowlisted.
  return { ok: true, finalUrl, reason: 'unknown-host-no-signal' };
}

// Parse the HTML head for article-classification signals. Returns
//   { positive: 'article' | 'news.article' | 'NewsArticle' | null,
//     negative: 'website' | 'profile' | 'product' | 'book' | null }
//
// "positive" wins over "negative" — but in practice a page never has
// both. Negative signals (`og:type=website`) are typical of section
// landing pages, profile pages, ETF / quote pages. Positive signals
// are what real articles emit.
function parseArticleSignals(html) {
  if (!html || typeof html !== 'string') return { positive: null, negative: null };

  // og:type — both single and double quotes; order of attributes can
  // vary; some pages use the X variant ("og:type" → "twitter:card" too).
  const ogTypeRe = /<meta[^>]+(?:property|name)\s*=\s*["']og:type["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i;
  const ogTypeReReverse = /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:type["'][^>]*>/i;
  const ogMatch = html.match(ogTypeRe) || html.match(ogTypeReReverse);
  if (ogMatch) {
    const value = ogMatch[1].trim().toLowerCase();
    if (value === 'article' || value === 'news.article' || value === 'news_article') {
      return { positive: value, negative: null };
    }
    if (
      value === 'website' ||
      value === 'profile' ||
      value === 'product' ||
      value === 'book' ||
      value === 'music' ||
      value === 'video'
    ) {
      return { positive: null, negative: value };
    }
  }

  // JSON-LD — look for "@type":"NewsArticle" or "Article" inside a
  // <script type="application/ld+json"> block. We don't fully parse
  // JSON; substring match is sufficient for the type signal.
  const ldRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    const block = m[1];
    if (
      /"@type"\s*:\s*"(?:NewsArticle|Article|ReportageNewsArticle|OpinionNewsArticle|AnalysisNewsArticle)"/i.test(block)
    ) {
      return { positive: 'json-ld', negative: null };
    }
  }

  return { positive: null, negative: null };
}
