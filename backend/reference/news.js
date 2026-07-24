// /api/news?q=Brookfield+Corp&ticker=BN+US&limit=50
//
// 1. Multi-engine news fan-out:
//    - Google News RSS (3 date-bucket variants — bare, when:1y, when:5y)
//    - Bing News RSS (single call)
//    - GDELT 2.0 DOC API (single call, global outlets, 5+yr archive)
//    Each runs in parallel; results dedup'd by URL before return.
// 2. If ANTHROPIC_API_KEY is set, ask Claude Haiku to:
//      a. Write a concise 1-2 sentence summary, AND
//      b. Classify each item as "news" (factual reporting) or
//         "opinion" (promotional, speculative, editorial).
// 3. Return enriched results.

import { searchBing, searchGdelt, searchHackerNews, searchEdgar, searchThinkTanks } from './_searchEngines.js';
import { stripCdata, extractTag, decodeHtmlEntities } from './_html.js';
import { looksLikeJunkPage } from './_urlFilters.js';
import { tagItem } from './_itemTagger.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { q, ticker, limit = '400' } = req.query;

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Missing q (search query) parameter' });
  }

  // Output cap raised 400 → 1500. Google News RSS returns up to ~100
  // items per query but we run multiple date-bucket variants + multi-
  // engine fan-out (Bing + GDELT + HN + EDGAR + Think-tanks) below
  // to expand the historical pool well past 400 unique URLs.
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 400, 1), 1500);

  // Date-bucket fanout — Google News RSS biases hard toward recent
  // results so a single bare query rarely returns content older than
  // ~30 days. Firing the same query with `when:1y` / `when:5y`
  // suffixes pulls in different historical snapshots that dedup into
  // a much larger pool. Empty string runs the bare query (most-
  // recent bucket).
  const DATE_BUCKETS = ['', 'when:1y', 'when:5y'];
  const urls = DATE_BUCKETS.map((bucket) => {
    const expandedQ = bucket ? `${q} ${bucket}` : q;
    return `https://news.google.com/rss/search?q=${encodeURIComponent(expandedQ)}&hl=en-US&gl=US&ceid=US:en`;
  });

  try {
    // Multi-engine parallel fan-out:
    //   - Google News × 3 date buckets
    //   - Bing News × 1 (different crawl, fills gaps)
    //   - GDELT × 1 (global outlets, multi-year archive)
    //   - Hacker News Algolia × 1 (deep-analysis pieces FinTwit /
    //     HN surfaces before mainstream)
    //   - SEC EDGAR × 1 (primary-source filings — material disclosures
    //     mentioning the theme in 8-K / 10-Q / 10-K text)
    //   - Think-tank / institutional RSS × 6 feeds (Atlantic Council,
    //     ECFR, Foreign Policy, Federal Reserve, PIIE, World Bank) —
    //     keyword-filtered against the theme name. Big for geopolitical
    //     / policy themes that mainstream press undercovers.
    const [googleResponses, bingItems, gdeltItems, hnItems, edgarItems, thinkTankItems] = await Promise.all([
      Promise.all(
        urls.map((url) =>
          fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; BluOrNewsTracker/1.0)',
              Accept: 'application/rss+xml, application/xml',
            },
          })
            .then((r) => (r.ok ? r.text() : ''))
            .catch(() => '')
        )
      ),
      searchBing(q, { limit: 200 }).catch(() => []),
      searchGdelt(q, { limit: 250 }).catch(() => []),
      searchHackerNews(q, { limit: 200 }).catch(() => []),
      searchEdgar(q, { limit: 200 }).catch(() => []),
      searchThinkTanks(q, { limit: 80 }).catch(() => []),
    ]);

    // Dedup by URL across all engines + date buckets; preserve
    // insertion order (Google first → Bing → GDELT → HN). Engines
    // later in the list only fill URLs the earlier ones didn't
    // already cover.
    const byUrl = new Map();
    for (const xml of googleResponses) {
      if (!xml) continue;
      for (const it of parseGoogleNewsRss(xml)) {
        if (!byUrl.has(it.url)) byUrl.set(it.url, { ...it, engine: 'google' });
      }
    }
    for (const it of bingItems) {
      if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    }
    for (const it of gdeltItems) {
      if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    }
    for (const it of hnItems) {
      if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    }
    for (const it of edgarItems) {
      if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    }
    for (const it of thinkTankItems) {
      if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    }
    let items = Array.from(byUrl.values());
    if (items.length === 0) {
      return res.status(502).json({ error: 'All upstream engines failed' });
    }
    // Phase 2 (inert): attach mentionedEntities / topics / sourceTier /
    // articleShape to every item before any filter runs. The tags are
    // observational only — downstream filters still use the legacy
    // looksLikeJunkPage gate. Phase 3 will introduce the relevance
    // gate that reads these tags.
    items = items.map((it) => tagItem(it, { originatingTicker: ticker || null }));
    // Drop stock-quote / metrics / profile / "Stock Symbol" landing
    // pages. Google News indexes these (Reuters /markets/companies/X/
    // key-metrics, MarketWatch /investing/stock/X, Bloomberg profile
    // pages, etc.) as if they were articles. See _urlFilters.js for
    // the headline + URL patterns.
    items = items.filter((it) => !looksLikeJunkPage(it));

    // Phase 10: cross-source headline dedup. The same article
    // syndicated across Yahoo Finance / Globe and Mail / Markets
    // Insider / Manila Times / Investing.com / MSN ends up as 3-6
    // cards with different URLs but the same normalized headline.
    // First-write-wins by normalized headline; later duplicates are
    // dropped. Mirrors the dedup must-reads.js applies — pulled here
    // so per-page feeds (CompanyDetail, theme detail) get the same
    // benefit.
    const byHeadlineKey = new Map();
    items = items.filter((it) => {
      const key = normalizeHeadline(it.headline);
      if (!key) return true; // short / unparseable headline — keep
      if (byHeadlineKey.has(key)) return false;
      byHeadlineKey.set(key, it.url);
      return true;
    });

    // Sort newest-first; undated items fall to the bottom.
    items.sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    });
    items = items.slice(0, limitNum);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && items.length > 0) {
      const toEnrich = items.slice(0, 20);
      const enriched = await enrichWithClaude(toEnrich, q, apiKey);
      const enrichedByUrl = new Map(enriched.map((s) => [s.url, s]));
      items = items.map((it) => {
        const e = enrichedByUrl.get(it.url);
        return {
          ...it,
          summary: e?.summary || '',
          articleType: e?.articleType || null, // 'news' | 'opinion' | null (unprocessed)
        };
      });
    }

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=600, stale-while-revalidate=3600'
    );

    return res.status(200).json({
      query: q,
      ticker: ticker || null,
      count: items.length,
      items,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}

// Normalize headline for cross-source dedup. Same algorithm as
// must-reads.js / cache-news.mjs — drops trailing publisher
// attribution ("... — Reuters"), strips punctuation, removes
// stopwords, sorts the remaining words alphabetically. Same article
// from Yahoo Finance / Globe and Mail / Markets Insider produces an
// identical key.
const NORMALIZE_STOPWORDS = new Set([
  'the','a','an','of','in','on','at','to','for','with','and','or',
  'but','from','by','as','is','are','was','were','be','been','has',
  'have','had','will','would','this','that','it','its','s','said',
  'says','after','before','over','up','down','about',
]);
function normalizeHeadline(s) {
  if (!s || typeof s !== 'string') return '';
  let cleaned = s.replace(/\s+[-–—]\s+[^-–—]{1,60}$/, '');
  cleaned = cleaned.toLowerCase();
  cleaned = cleaned
    .replace(/['‘’“”]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter((w) => w && !NORMALIZE_STOPWORDS.has(w));
  if (words.length < 5) return '';
  return words.sort().join(' ');
}

// ---- Claude enrichment: summary + classification ----

async function enrichWithClaude(items, companyName, apiKey) {
  const prompt = `You are an analyst at BluOr Asset Management triaging news for portfolio holdings.

For each headline about "${companyName}" below, do TWO things:

1. SUMMARY: 1-2 concise sentences describing what likely happened and (if relevant) why it might matter. Use your knowledge of the company to add brief context. Be neutral and factual. Do not speculate beyond what the headline implies.

2. CLASSIFY as either:
   - "news"   = factual reporting of an event, transaction, earnings, regulatory action, deal, management change, operational update, market data, official disclosure, or wire-style summary of facts.
   - "opinion" = analyst recommendation, "X reasons to buy/sell," ratings or price targets reframed as analysis, contributor pump pieces, retail-investor takes, listicles, speculative or promotional articles. Anything where the article's primary value is the AUTHOR'S TAKE rather than NEW FACTS.

When in doubt — if the headline is framed neutrally and reports an event — call it "news". Reserve "opinion" for clearly promotional, retail-focused, or take-driven pieces.

Return STRICT JSON only — no markdown fences, no preamble. Format:
[{"url":"...","summary":"...","articleType":"news"|"opinion"}]

Headlines:
${items
  .map(
    (it, i) =>
      `${i + 1}. [${it.source}] ${it.headline}\nURL: ${it.url}`
  )
  .join('\n\n')}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return items.map((it) => ({ url: it.url, summary: '', articleType: null }));
    const data = await r.json();
    const text = data?.content?.[0]?.text || '';
    const cleaned = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return items.map((it) => ({ url: it.url, summary: '', articleType: null }));
    return parsed.map((p) => ({
      url: p.url,
      summary: typeof p.summary === 'string' ? p.summary : '',
      articleType: p.articleType === 'opinion' ? 'opinion' : p.articleType === 'news' ? 'news' : null,
    }));
  } catch {
    return items.map((it) => ({ url: it.url, summary: '', articleType: null }));
  }
}

// ---- Google News RSS parsing ----

function parseGoogleNewsRss(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1];
    const title = stripCdata(extractTag(content, 'title'));
    const link = stripCdata(extractTag(content, 'link'));
    const pubDate = stripCdata(extractTag(content, 'pubDate'));
    const sourceMatch = content.match(/<source[^>]*>([^<]+)<\/source>/);
    const source = sourceMatch ? decodeHtmlEntities(sourceMatch[1].trim()) : 'Unknown';

    if (title && link) {
      const date = new Date(pubDate);
      items.push({
        headline: cleanTitle(title, source),
        url: link,
        source,
        time: !isNaN(date.getTime()) ? date.toISOString() : null,
        summary: '',
        articleType: null,
      });
    }
  }
  return items;
}

function cleanTitle(title, source) {
  if (source && title.endsWith(` - ${source}`)) {
    return title.slice(0, -(source.length + 3)).trim();
  }
  return title;
}
