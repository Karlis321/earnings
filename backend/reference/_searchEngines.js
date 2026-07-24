// Multi-source search engine fan-out.
//
// One module, one job: surface news items from multiple free /
// no-auth search backends so the news pool isn't single-sourced
// against Google News. Each `search*` function returns a normalized
// item array:
//
//   { headline, url, source, time, summary, engine }
//
// `engine` is a stable identifier ('bing', 'gdelt', 'hn', 'edgar',
// 'yahoo', 'thinktank', 'google') the rest of the pipeline can use
// for diagnostic chips or per-engine ranking.
//
// All functions:
//   - Time-bound their fetch (default 8 s timeout).
//   - Return [] on any failure (network, parse, rate-limit).
//   - Never throw.
//
// Wired into api/news.js (per-stock / per-theme news endpoint) and
// api/must-reads.js (home feed + Quick Look Up). Each engine runs
// in parallel; the caller dedup's the union by URL.

import { stripCdata, decodeHtmlEntities as decodeHtml } from './_html.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SEC fair-access policy requires a User-Agent with a contact.
// Mirrored from api/_feedFetcher.js where EDGAR fetches already use
// the same string.
const SEC_UA = 'BluOr News Tracker klpp@bluorbank.lv';

const DEFAULT_TIMEOUT_MS = 8000;

// =====================================================================
// Generic helpers
// =====================================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

function matchTag(c, tag) {
  const m = c.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripCdata(m[1]) : '';
}

function safeIsoDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// =====================================================================
// Bing News RSS
// =====================================================================
//
// Endpoint: https://www.bing.com/news/search?q=<query>&format=rss
//
// Different crawl from Google News — gives a genuinely different
// result set. Items wrap their target URL via
// http://www.bing.com/news/apiclick.aspx?...&url=<encoded-real-url>
// so we extract the real publisher URL from the `url` query param.
// The `<News:Source>` tag in the Bing RSS namespace carries the
// publisher name.

export async function searchBing(query, opts = {}) {
  if (!query || typeof query !== 'string') return [];
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  try {
    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/rss+xml, application/xml, text/xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      opts.timeoutMs || DEFAULT_TIMEOUT_MS
    );
    if (!r.ok) return [];
    const xml = await r.text();
    return parseBingRss(xml, opts.limit || 50);
  } catch {
    return [];
  }
}

function parseBingRss(xml, limit) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && out.length < limit) {
    const c = m[1];
    const title = matchTag(c, 'title');
    const link = matchTag(c, 'link');
    const description = matchTag(c, 'description');
    const pub = matchTag(c, 'pubDate');
    // News:Source is in a namespaced tag — same regex helper handles it.
    const sourceMatch = c.match(/<News:Source[^>]*>([\s\S]*?)<\/News:Source>/i);
    const source = sourceMatch ? stripCdata(sourceMatch[1]).trim() : 'Bing News';

    if (!title || !link) continue;

    // Bing wraps the real URL in an apiclick.aspx redirect. Extract
    // the `url=` param so clicks go direct to the publisher. The link
    // pulled from RSS still carries `&amp;` entity encodings — decode
    // those first so the regex can find the param boundary.
    const decodedLink = decodeHtml(link);
    let finalUrl = decodedLink;
    const urlMatch = decodedLink.match(/[?&]url=([^&]+)/i);
    if (urlMatch) {
      try {
        finalUrl = decodeURIComponent(urlMatch[1]);
      } catch {
        // Keep the decoded wrapper if URL-decode fails.
      }
    }

    out.push({
      headline: cleanTitleSuffix(decodeHtml(title), source),
      url: finalUrl,
      source: decodeHtml(source) || 'Bing News',
      time: safeIsoDate(pub),
      summary: decodeHtml(description).slice(0, 400),
      engine: 'bing',
    });
  }
  return out;
}

// Many RSS feeds append " - <Source>" to the title. Strip it so the
// chip and the headline don't both repeat the source.
function cleanTitleSuffix(title, source) {
  if (!title) return '';
  if (source && title.endsWith(` - ${source}`)) {
    return title.slice(0, -(source.length + 3)).trim();
  }
  return title;
}

// =====================================================================
// GDELT 2.0 DOC API
// =====================================================================
//
// Endpoint:
//   https://api.gdeltproject.org/api/v2/doc/doc?query=<q>&mode=ArtList
//     &format=json&maxrecords=<n>&sort=DateDesc
//
// Underrated global news index — covers 5+ years of articles across
// ~250k outlets in 80+ languages, including regional/niche publishers
// that Google News misses. Free, no auth, JSON response.
//
// Rate limit: 1 request / 5 seconds per IP (their docs). Fine for
// /api/news (single query per request), and the cron pre-fetcher
// serialises with throttling.
//
// Response shape:
//   {
//     articles: [
//       { url, title, seendate ("YYYYMMDDTHHMMSSZ"), domain,
//         language, sourcecountry, socialimage }
//     ]
//   }
//
// On rate-limit hit, GDELT returns a plain-text 200 starting with
// "Please limit requests..." — we detect and return [] in that case.

export async function searchGdelt(query, opts = {}) {
  if (!query || typeof query !== 'string') return [];
  const params = new URLSearchParams({
    query,
    mode: 'ArtList',
    format: 'json',
    maxrecords: String(opts.limit || 75),
    sort: 'DateDesc',
  });
  if (opts.startDateTime) params.set('startdatetime', opts.startDateTime);
  if (opts.endDateTime) params.set('enddatetime', opts.endDateTime);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
  try {
    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          'User-Agent': 'BluOrNewsTracker/1.0 (klpp@bluorbank.lv)',
          Accept: 'application/json',
        },
      },
      opts.timeoutMs || DEFAULT_TIMEOUT_MS
    );
    if (!r.ok) return [];
    const text = await r.text();
    if (!text || text.startsWith('Please limit')) return [];
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    return articles
      .filter((a) => a && a.url && a.title)
      .map((a) => ({
        headline: cleanTitleSuffix(decodeHtml(a.title), a.domain),
        url: a.url,
        source: a.domain || 'GDELT',
        time: parseGdeltDate(a.seendate),
        summary: '',
        engine: 'gdelt',
      }))
      .slice(0, opts.limit || 75);
  } catch {
    return [];
  }
}

// GDELT seendate is `YYYYMMDDTHHMMSSZ`. Convert to ISO.
function parseGdeltDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return safeIsoDate(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

// =====================================================================
// Hacker News (Algolia search API)
// =====================================================================
//
// Endpoint:
//   https://hn.algolia.com/api/v1/search_by_date?query=<q>&tags=story
//     &hitsPerPage=<n>
//
// HN's submissions are biased toward quality long-form pieces — when
// FT / Bloomberg / WSJ publish deep analysis, it usually surfaces on
// HN's front page within 24h. The Algolia search exposes the full
// submission archive (years deep) with JSON responses, no auth, no
// rate limit beyond reasonable use.
//
// Response shape:
//   { hits: [
//       { title, url, author, created_at, points, num_comments,
//         objectID, story_id }
//   ]}
//
// Items without a URL (Ask HN / Show HN text posts) map to the
// HN discussion thread URL.

export async function searchHackerNews(query, opts = {}) {
  if (!query || typeof query !== 'string') return [];
  const params = new URLSearchParams({
    query,
    tags: 'story',
    hitsPerPage: String(opts.limit || 50),
  });
  // search_by_date sorts newest-first, which keeps the merge stage
  // honest (other engines also surface newest-first). For more
  // relevance-weighted results, switch to /search (default sort).
  const url = `https://hn.algolia.com/api/v1/search_by_date?${params.toString()}`;
  try {
    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
        },
      },
      opts.timeoutMs || DEFAULT_TIMEOUT_MS
    );
    if (!r.ok) return [];
    const data = await r.json();
    const hits = Array.isArray(data?.hits) ? data.hits : [];
    return hits
      .filter((h) => h && h.title)
      .map((h) => {
        const articleUrl =
          h.url ||
          (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null);
        if (!articleUrl) return null;
        return {
          headline: decodeHtml(h.title),
          url: articleUrl,
          source: extractDomain(articleUrl) || 'Hacker News',
          time: safeIsoDate(h.created_at),
          summary: '',
          engine: 'hn',
          // Engagement metadata — not used by the news pipeline yet
          // but cheap to carry through for a future "HN discussion"
          // chip on cards.
          hnPoints: typeof h.points === 'number' ? h.points : 0,
          hnComments: typeof h.num_comments === 'number' ? h.num_comments : 0,
          hnId: h.objectID || null,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractDomain(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// =====================================================================
// SEC EDGAR full-text search
// =====================================================================
//
// Endpoint:
//   https://efts.sec.gov/LATEST/search-index?q=<query>&forms=8-K,10-K,10-Q
//
// Catches risk-factor language and material filings that mention the
// theme — for themes touching US-listed companies (private credit,
// energy commodities affected by Strait of Hormuz, etc.) this surfaces
// hard-to-reach primary-source disclosures.
//
// Response shape (Elasticsearch-flavoured):
//   {
//     hits: {
//       hits: [
//         {
//           _id: "<adsh>:<filename>",
//           _source: {
//             ciks: ["0001234567"],
//             display_names: ["Company Name (TICKER) (CIK 0001234567)"],
//             form: "8-K",
//             file_date: "YYYY-MM-DD",
//             file_description: "...",
//             adsh: "0001234567-26-001234"
//           }
//         }
//       ]
//     }
//   }

const EDGAR_DEFAULT_FORMS = ['8-K', '10-K', '10-Q', '6-K', '20-F', '40-F'];

export async function searchEdgar(query, opts = {}) {
  if (!query || typeof query !== 'string') return [];
  const forms = (opts.forms || EDGAR_DEFAULT_FORMS).join(',');
  const params = new URLSearchParams({
    q: query,
    forms,
  });
  if (opts.startDate) params.set('dateRange', 'custom');
  if (opts.startDate) params.set('startdt', opts.startDate);
  if (opts.endDate) params.set('enddt', opts.endDate);
  const url = `https://efts.sec.gov/LATEST/search-index?${params.toString()}`;
  try {
    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          // SEC fair-access policy requires a contact in the UA.
          'User-Agent': SEC_UA,
          Accept: 'application/json',
        },
      },
      opts.timeoutMs || DEFAULT_TIMEOUT_MS
    );
    if (!r.ok) return [];
    const data = await r.json();
    const hits = data?.hits?.hits;
    if (!Array.isArray(hits)) return [];
    return hits
      .map((h) => parseEdgarHit(h))
      .filter(Boolean)
      .slice(0, opts.limit || 50);
  } catch {
    return [];
  }
}

function parseEdgarHit(hit) {
  if (!hit || !hit._source) return null;
  const s = hit._source;
  const cik = (s.ciks && s.ciks[0]) || null;
  const adsh = s.adsh;
  if (!cik || !adsh) return null;
  // _id is "<adsh>:<filename>" — split to get the file part.
  const colonIdx = (hit._id || '').indexOf(':');
  const filename = colonIdx > 0 ? hit._id.slice(colonIdx + 1) : 'index.htm';
  // Filing URL: https://www.sec.gov/Archives/edgar/data/<cik-int>/<adsh-no-dashes>/<filename>
  const cikInt = String(parseInt(cik, 10));
  const adshNoDashes = adsh.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${adshNoDashes}/${filename}`;
  const company = (s.display_names && s.display_names[0]) || 'SEC filing';
  // Strip the CIK / file-num suffix from display name: "Acme Co (ACME) (CIK 0001234)" → "Acme Co (ACME)"
  const companyClean = company.replace(/\s*\(CIK\s+\d+\)\s*$/, '').trim();
  const form = s.form || '';
  const desc = s.file_description || s.file_type || '';
  const headline = desc && desc !== form
    ? `${companyClean} — ${form} · ${desc}`
    : `${companyClean} — ${form}`;
  return {
    headline,
    url,
    source: 'SEC EDGAR',
    time: safeIsoDate(s.file_date),
    summary: '',
    engine: 'edgar',
    // Helpful for downstream chips / scoping:
    edgarForm: form,
    edgarCik: cikInt,
  };
}

// =====================================================================
// Engine list — used by the multi-engine fan-out helper.
// =====================================================================

// =====================================================================
// Think-tank / institutional RSS feeds
// =====================================================================
//
// Hand-curated set of policy / economic / geopolitical institutions
// that publish public RSS. We fetch the full latest feed from each
// (cached in-process for 15 min) and keyword-match against the
// query's name words — these aren't searchable APIs, they're
// firehose feeds.
//
// Probed 2026-06-08:
//   ✓ Atlantic Council    https://www.atlanticcouncil.org/feed/
//   ✓ ECFR (Eur. Council) https://ecfr.eu/feed/
//   ✓ Foreign Policy mag  https://foreignpolicy.com/feed/
//   ✓ US Federal Reserve  https://www.federalreserve.gov/feeds/press_all.xml
//   ✓ PIIE                https://feeds.feedburner.com/PetersonInstituteForInternationalEconomics
//   ✓ World Bank          https://www.worldbank.org/en/news/all?fileType=rss
//
//   ✗ CFR, Brookings, CSIS, Chatham House, RAND, IISS, IMF — all
//     anti-bot or moved their feeds. Skipped.

const THINK_TANK_FEEDS = [
  { id: 'atlantic-council', name: 'Atlantic Council',   url: 'https://www.atlanticcouncil.org/feed/' },
  { id: 'ecfr',             name: 'ECFR',               url: 'https://ecfr.eu/feed/' },
  { id: 'foreign-policy',   name: 'Foreign Policy',     url: 'https://foreignpolicy.com/feed/' },
  { id: 'federal-reserve',  name: 'Federal Reserve',    url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { id: 'piie',             name: 'PIIE',               url: 'https://feeds.feedburner.com/PetersonInstituteForInternationalEconomics' },
  { id: 'world-bank',       name: 'World Bank',         url: 'https://www.worldbank.org/en/news/all?fileType=rss' },
];

// In-process cache for parsed feeds. Vercel keeps the function warm
// between requests so this hits ~once per feed every 15 min.
const FEED_CACHE = new Map();
const FEED_TTL_MS = 15 * 60 * 1000;

async function fetchAndParseFeed(feed) {
  const cached = FEED_CACHE.get(feed.url);
  if (cached && Date.now() - cached.ts < FEED_TTL_MS) return cached.items;
  try {
    const r = await fetchWithTimeout(
      feed.url,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml',
        },
      },
      DEFAULT_TIMEOUT_MS
    );
    if (!r.ok) {
      FEED_CACHE.set(feed.url, { items: [], ts: Date.now() });
      return [];
    }
    const xml = await r.text();
    const items = parseGenericRss(xml, feed.name);
    FEED_CACHE.set(feed.url, { items, ts: Date.now() });
    return items;
  } catch {
    FEED_CACHE.set(feed.url, { items: [], ts: Date.now() });
    return [];
  }
}

// Minimal RSS 2.0 + Atom parser — covers the feed shapes the
// think-tank list emits. Skips media: / dc: / content: namespaces
// (we only need title / link / pubDate / description).
function parseGenericRss(xml, sourceName) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const c = m[1] || m[2] || '';
    if (!c) continue;
    const title = matchTag(c, 'title');
    let link = matchTag(c, 'link');
    // Atom <link href="..."/> — when matchTag returns empty, try the
    // self-closing form.
    if (!link) {
      const hrefMatch = c.match(/<link[^>]+href="([^"]+)"/i);
      if (hrefMatch) link = hrefMatch[1];
    }
    const pubDate = matchTag(c, 'pubDate') || matchTag(c, 'published') || matchTag(c, 'updated');
    const description = matchTag(c, 'description') || matchTag(c, 'summary');
    if (!title || !link) continue;
    out.push({
      headline: decodeHtml(title),
      url: link,
      source: sourceName,
      time: safeIsoDate(pubDate),
      summary: decodeHtml(description).replace(/<[^>]+>/g, '').slice(0, 400),
      engine: 'thinktank',
    });
  }
  return out;
}

// Extract significant query keywords for filtering. Mirrors the logic
// /api/tweets uses — pull the bare-name section of the constructed
// query, drop stopwords, length ≥3.
function extractFilterKeywords(query) {
  if (!query || typeof query !== 'string') return [];
  const STOPLIKE = new Set([
    'the','and','for','site','when','before','after','about','from','that',
    'this','your','will','have','with','into','their','them','then','than',
    'also','been','were','was','are','its','of','an','a','to','in','on','at',
    'by','as','is','be','or','but',
  ]);
  // Prefer the quoted phrase or bare-word prefix before any OR group.
  let nameSection;
  const quotedMatch = query.match(/^\s*"([^"]+)"/);
  if (quotedMatch) {
    nameSection = quotedMatch[1];
  } else {
    const cut = query.search(/[("]/);
    nameSection = cut >= 0 ? query.slice(0, cut) : query;
  }
  return Array.from(
    new Set(
      nameSection
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPLIKE.has(w))
    )
  );
}

// Phase 4 hard time floor for thinktank items. The 2026-06-08 audit
// found PIIE essays from 2012 surfacing on the Brazil Fiscal Policy
// theme because their headlines happened to match keywords like
// "fiscal" or "inflation". Thinktank archives stretch back many
// years; without a date floor here, every keyword search retrieves
// historical commentary that's no longer market-relevant. 180 days
// is the tightest floor that still catches multi-month policy arcs
// (an Atlantic Council piece from 4 months ago about an ongoing
// conflict, e.g., remains material).
const THINKTANK_AGE_FLOOR_DAYS = 180;

export async function searchThinkTanks(query, opts = {}) {
  const kws = extractFilterKeywords(query);
  if (kws.length === 0) return [];
  const feedsArrays = await Promise.all(THINK_TANK_FEEDS.map(fetchAndParseFeed));
  const cutoff = Date.now() - THINKTANK_AGE_FLOOR_DAYS * 24 * 60 * 60 * 1000;
  const out = [];
  for (const items of feedsArrays) {
    for (const it of items) {
      // Drop thinktank items older than the floor BEFORE the keyword
      // match. An ageless or unparseable date passes through so a
      // genuinely undated essay isn't silently dropped (rare; most
      // thinktank feeds publish dates reliably).
      if (it.time) {
        const t = new Date(it.time).getTime();
        if (!Number.isNaN(t) && t < cutoff) continue;
      }
      const hay = ((it.headline || '') + ' ' + (it.summary || '')).toLowerCase();
      if (kws.some((kw) => hay.includes(kw))) {
        out.push(it);
      }
    }
  }
  // Sort newest-first, cap.
  out.sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : 0;
    const tb = b.time ? new Date(b.time).getTime() : 0;
    return tb - ta;
  });
  return out.slice(0, opts.limit || 30);
}

export const ENGINES = {
  bing: searchBing,
  gdelt: searchGdelt,
  hn: searchHackerNews,
  edgar: searchEdgar,
  thinktank: searchThinkTanks,
};

// Run every engine in `engines` in parallel for the same query.
// Returns the merged + URL-deduplicated array, newest-first.
//
// `engines` defaults to all registered engines; pass a subset to
// limit the fan-out (e.g. ['bing', 'gdelt'] for a tighter run).
export async function searchAllEngines(query, opts = {}) {
  const wanted = opts.engines || Object.keys(ENGINES);
  const fns = wanted.map((name) => ENGINES[name]).filter(Boolean);
  if (fns.length === 0) return [];
  const results = await Promise.all(
    fns.map((fn) =>
      fn(query, opts).catch(() => [])
    )
  );
  return mergeByUrl(results.flat());
}

// Dedup by URL. First write wins so engine order matters for tie
// breaking (Google News usually first because of brand recognition;
// Bing / GDELT / etc. fill gaps).
export function mergeByUrl(items) {
  const byUrl = new Map();
  for (const it of items) {
    if (!it || !it.url) continue;
    if (!byUrl.has(it.url)) byUrl.set(it.url, it);
  }
  // Sort newest-first; undated items fall to the bottom.
  return Array.from(byUrl.values()).sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : 0;
    const tb = b.time ? new Date(b.time).getTime() : 0;
    return tb - ta;
  });
}

// Exposed for diagnostic / logging.
export const _internal = {
  fetchWithTimeout,
  matchTag,
  stripCdata,
  safeIsoDate,
  decodeHtml,
  cleanTitleSuffix,
  parseBingRss,
  SEC_UA,
  BROWSER_UA,
};
