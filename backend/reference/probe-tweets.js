// One-shot diagnostic endpoint — fetches several "what people are saying"
// sources to find out which ones Vercel's egress IP can actually reach.
// DDG and Bluesky are confirmed blocked; this checks for alternatives
// we haven't tried at production scale yet.
//
// GET /api/_probe?q=Brookfield+Corp&symbol=BAM
//
// Returns per-source status + sample item count so we know what's
// worth wiring into a real tweets-replacement pipeline.

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export default async function handler(req, res) {
  const q = typeof req.query.q === 'string' ? req.query.q : 'Brookfield Corp';
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : 'BAM';

  const handleParam = typeof req.query.handle === 'string' ? req.query.handle : 'Brookfield';
  const tests = [
    {
      name: 'nitter-profile-rss',
      // Direct from Vercel — expected to fail with "fetch failed" because
      // nitter.net's host TCP-rejects AWS/Vercel egress.
      url: `https://nitter.net/${encodeURIComponent(handleParam)}/rss`,
      parse: (text) => (text.match(/<item>/g) || []).length,
    },
    ...(process.env.TWEET_WORKER_URL
      ? [{
          name: 'nitter-via-worker',
          // Routed through the Cloudflare Worker. This is the real path
          // /api/tweets uses; if direct nitter fails but this one 200s
          // with ~20 items, the pipeline is healthy.
          url: `${process.env.TWEET_WORKER_URL.replace(/\/$/, '')}/?nitter=${encodeURIComponent(handleParam)}`,
          headers: process.env.TWEET_WORKER_SECRET ? { 'X-Auth': process.env.TWEET_WORKER_SECRET } : undefined,
          parse: (text) => (text.match(/<item>/g) || []).length,
        }]
      : []),
    {
      name: 'stocktwits',
      url: `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`,
      parse: (text) => {
        try {
          const j = JSON.parse(text);
          return Array.isArray(j?.messages) ? j.messages.length : 0;
        } catch { return 0; }
      },
    },
    {
      name: 'reddit-search-rss',
      url: `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&limit=10`,
      parse: (text) => (text.match(/<entry>/g) || []).length,
    },
    {
      name: 'reddit-search-json',
      url: `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&limit=10`,
      parse: (text) => {
        try {
          const j = JSON.parse(text);
          return Array.isArray(j?.data?.children) ? j.data.children.length : 0;
        } catch { return 0; }
      },
    },
    {
      name: 'yahoo-quote-summary',
      url: `https://query2.finance.yahoo.com/v6/finance/quoteSummary/${symbol}?modules=summaryDetail`,
      parse: (text) => (text.length > 100 ? 1 : 0),
    },
    {
      name: 'google-news-rss',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('"' + q + '" twitter')}&hl=en-US&gl=US&ceid=US:en`,
      parse: (text) => (text.match(/<item>/g) || []).length,
    },
    {
      name: 'hackernews-algolia',
      url: `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=10`,
      parse: (text) => {
        try {
          const j = JSON.parse(text);
          return Array.isArray(j?.hits) ? j.hits.length : 0;
        } catch { return 0; }
      },
    },
  ];

  const results = [];
  await Promise.all(
    tests.map(async (t) => {
      const t0 = Date.now();
      try {
        const r = await fetch(t.url, { headers: { ...BROWSER_HEADERS, ...(t.headers || {}) } });
        const text = await r.text();
        results.push({
          name: t.name,
          status: r.status,
          bytes: text.length,
          items: t.parse(text),
          ms: Date.now() - t0,
        });
      } catch (e) {
        results.push({ name: t.name, error: e.message, ms: Date.now() - t0 });
      }
    })
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    query: q,
    symbol,
    fetchedAt: new Date().toISOString(),
    results,
  });
}
