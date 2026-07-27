// News fan-out — RSS sources from backend/reference/news.txt.txt.
// Fetches Reuters/AP/FT/Bloomberg/WSJ/Economist/mining/defense/energy/central banks.
// Each source fails soft to []; siblings keep running.

const RSS_SOURCES: Array<{ name: string; url: string; category: string }> = [
  // Tier 1 wires + global macro
  { name: "Reuters Business", url: "https://news.google.com/rss/search?q=site:reuters.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "wire" },
  { name: "AP Business", url: "https://news.google.com/rss/search?q=site:apnews.com+business+when:7d&hl=en-US&gl=US&ceid=US:en", category: "wire" },
  { name: "FT Markets", url: "https://www.ft.com/markets?format=rss", category: "wire" },
  { name: "FT Companies", url: "https://www.ft.com/companies?format=rss", category: "wire" },
  { name: "FT World", url: "https://www.ft.com/world?format=rss", category: "wire" },
  { name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss", category: "wire" },
  { name: "Bloomberg Politics", url: "https://feeds.bloomberg.com/politics/news.rss", category: "wire" },
  { name: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", category: "wire" },
  { name: "WSJ World", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml", category: "wire" },
  { name: "MarketWatch Top", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", category: "wire" },
  { name: "Semafor", url: "https://news.google.com/rss/search?q=site:semafor.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "wire" },

  // Economist — their direct rss.xml feeds throw 403 for non-browser fetchers
  // and even 200-empty for many geolocations. Routing via Google News gives
  // us the same headline stream reliably.
  { name: "Economist Finance", url: "https://news.google.com/rss/search?q=site:economist.com+finance+when:7d&hl=en-US&gl=US&ceid=US:en", category: "analysis" },
  { name: "Economist Business", url: "https://news.google.com/rss/search?q=site:economist.com+business+when:7d&hl=en-US&gl=US&ceid=US:en", category: "analysis" },
  { name: "Economist Leaders", url: "https://news.google.com/rss/search?q=site:economist.com+leaders+when:7d&hl=en-US&gl=US&ceid=US:en", category: "analysis" },
  { name: "Economist International", url: "https://news.google.com/rss/search?q=site:economist.com+international+when:7d&hl=en-US&gl=US&ceid=US:en", category: "analysis" },

  // Mining / critical minerals
  { name: "Northern Miner", url: "https://www.northernminer.com/feed/", category: "mining" },
  { name: "Canadian Mining Journal", url: "https://www.canadianminingjournal.com/feed/", category: "mining" },
  { name: "Mining.com", url: "https://news.google.com/rss/search?q=site:mining.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "mining" },
  { name: "Kitco", url: "https://news.google.com/rss/search?q=site:kitco.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "mining" },

  // Defense
  { name: "Defense News", url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml", category: "defense" },
  { name: "Breaking Defense", url: "https://breakingdefense.com/feed/", category: "defense" },
  { name: "Defense One", url: "https://www.defenseone.com/rss/all/", category: "defense" },

  // Energy / nuclear / renewables
  { name: "World Nuclear News", url: "https://www.world-nuclear-news.org/rss", category: "energy" },
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", category: "energy" },
  { name: "Reuters Energy", url: "https://news.google.com/rss/search?q=site:reuters.com+energy+OR+oil+OR+gas+when:7d&hl=en-US&gl=US&ceid=US:en", category: "energy" },
  { name: "Renewables", url: "https://news.google.com/rss/search?q=offshore+wind+OR+solar+OR+renewables+when:7d&hl=en-US&gl=US&ceid=US:en", category: "energy" },

  // Asia / EM
  { name: "Nikkei Asia", url: "https://news.google.com/rss/search?q=site:asia.nikkei.com+when:7d&hl=en-US&gl=US&ceid=US:en", category: "asia" },
  { name: "SCMP", url: "https://www.scmp.com/rss/91/feed", category: "asia" },

  // Europe / EU policy
  { name: "Politico EU", url: "https://www.politico.eu/feed/", category: "eu" },

  // Central banks
  { name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", category: "central-bank" },
  { name: "ECB press", url: "https://www.ecb.europa.eu/rss/press.html", category: "central-bank" },
  { name: "BoE news", url: "https://www.bankofengland.co.uk/rss/news", category: "central-bank" },
];

export interface NewsItem {
  headline: string;
  url: string;
  source: string;
  category: string;
  time: string | null;
}

const UA = "Mozilla/5.0 EarningsDashboard/1.0 (+contact@example.com)";

async function fetchRss(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Compact RSS/Atom item parser — no deps. Handles both <item> (RSS) and <entry> (Atom).
function parseFeed(xml: string, source: string, category: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g;
  const matches = xml.match(itemRegex) ?? [];
  for (const block of matches.slice(0, 15)) {
    const titleMatch =
      block.match(/<title[^>]*>([\s\S]*?)<\/title>/) ?? null;
    const linkMatch =
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/) ??
      block.match(/<link[^>]*href="([^"]+)"/) ??
      null;
    const dateMatch =
      block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ??
      block.match(/<published>([\s\S]*?)<\/published>/) ??
      block.match(/<updated>([\s\S]*?)<\/updated>/) ??
      null;

    if (!titleMatch || !linkMatch) continue;
    const headline = decodeEntities(
      titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim(),
    );
    const url = decodeEntities(linkMatch[1].trim());
    if (!headline || !url || url.startsWith("<")) continue;

    let time: string | null = null;
    if (dateMatch) {
      try {
        time = new Date(dateMatch[1].trim()).toISOString();
      } catch {
        /* leave null */
      }
    }
    items.push({ headline, url, source, category, time });
  }
  return items;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

export interface NewsFanoutResult {
  fetchedAt: string;
  items: NewsItem[];
  engineStatus: Array<{
    source: string;
    category: string;
    ok: boolean;
    itemsFound: number;
  }>;
  redirectsResolved?: number;
}

// Google News RSS returns opaque redirect URLs like
// https://news.google.com/rss/articles/<base64>?... — one HTTP hop away
// from the actual publisher. Resolve them so users click straight through
// (also improves dedup — different Google News URLs can point at the same
// article). Fail-soft: on any error the original URL is kept.
const GNEWS_REDIRECT_RE = /^https?:\/\/news\.google\.com\/(?:rss\/)?articles\//i;

async function resolveGoogleNewsUrl(url: string): Promise<string> {
  try {
    // HEAD first — cheaper; not all origins support it, so fall back to GET.
    const attempts: Array<"HEAD" | "GET"> = ["HEAD", "GET"];
    for (const method of attempts) {
      try {
        const r = await fetch(url, {
          method,
          redirect: "follow",
          headers: { "User-Agent": UA, Accept: "text/html,*/*" },
          signal: AbortSignal.timeout(6000),
        });
        const final = r.url;
        if (final && !GNEWS_REDIRECT_RE.test(final)) return final;
        break;
      } catch {
        if (method === "GET") return url;
        continue;
      }
    }
  } catch {
    /* fall through to original */
  }
  return url;
}

async function resolveGoogleNewsUrls(items: NewsItem[]): Promise<number> {
  const CONCURRENCY = 8;
  const targets = items
    .map((it, idx) => ({ idx, url: it.url }))
    .filter(({ url }) => GNEWS_REDIRECT_RE.test(url));
  if (targets.length === 0) return 0;
  let resolved = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const mine = cursor++;
      const t = targets[mine];
      const final = await resolveGoogleNewsUrl(t.url);
      if (final !== t.url) {
        items[t.idx].url = final;
        resolved++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return resolved;
}

interface FanoutOpts {
  query?: string;
  days?: number; // hard time-window cutoff on the client side (default 7)
  resolveRedirects?: boolean; // default true — one HEAD hop per gnews URL
}

// Rewrite Google News URLs to use the requested days window (when:Nd).
// Non-Google-News URLs pass through unchanged.
function urlForDays(url: string, days: number): string {
  return url.replace(/when:\d+d/g, `when:${days}d`);
}

export async function fanoutNews(
  opts: FanoutOpts = {},
): Promise<NewsFanoutResult> {
  const days = Math.max(1, Math.min(365, opts.days ?? 7));
  const cutoff = Date.now() - days * 86_400_000;

  const results = await Promise.all(
    RSS_SOURCES.map(async (src) => {
      const xml = await fetchRss(urlForDays(src.url, days));
      if (xml === null) {
        return { src, ok: false as const, items: [] as NewsItem[] };
      }
      const items = parseFeed(xml, src.name, src.category);
      return { src, ok: true as const, items };
    }),
  );

  const q = opts.query?.trim().toLowerCase();
  const allItems = results.flatMap((r) => r.items);
  // Hard cutoff by parsed time. Items with no parseable date pass (we can't
  // discard them safely — some feeds omit pubDate entirely).
  const timeFiltered = allItems.filter((i) => {
    if (!i.time) return true;
    return new Date(i.time).getTime() >= cutoff;
  });
  const filtered = q
    ? timeFiltered.filter(
        (i) =>
          i.headline.toLowerCase().includes(q) ||
          i.source.toLowerCase().includes(q),
      )
    : timeFiltered;

  // Resolve Google News redirect URLs to publisher URLs before dedup so
  // two gnews URLs pointing at the same Reuters article collapse to one.
  let redirectsResolved = 0;
  if (opts.resolveRedirects !== false) {
    redirectsResolved = await resolveGoogleNewsUrls(filtered);
  }

  // Dedup by URL, then by normalized headline
  const seen = new Set<string>();
  const dedup: NewsItem[] = [];
  for (const it of filtered) {
    const key = it.url.split("?")[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(it);
  }
  dedup.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));

  return {
    fetchedAt: new Date().toISOString(),
    items: dedup.slice(0, 100),
    engineStatus: results.map((r) => ({
      source: r.src.name,
      category: r.src.category,
      ok: r.ok,
      itemsFound: r.items.length,
    })),
    redirectsResolved,
  };
}

export const NEWS_CATEGORIES = Array.from(
  new Set(RSS_SOURCES.map((s) => s.category)),
);

// Per-entity Google News search. Builds a single RSS URL with an OR'd
// query of the entity's aliases + cashtag + Yahoo-suffix forms. Fetches,
// parses, time-filters, and resolves the same Google News redirects as
// the shared pool. Runs once per unique ticker in the cron; cached at
// the call site.
export interface EntityNewsResult {
  fetchedAt: string;
  ticker: string;
  items: NewsItem[];
  ok: boolean;
  itemsFound: number;
  redirectsResolved: number;
}

// Google News quotes multi-word phrases and joins with OR. Cashtags come
// in unquoted since they're single tokens. Cap the query to a sensible
// length (Google truncates around 500 chars anyway).
function buildGoogleNewsUrl(tokens: string[], days: number): string {
  const q = tokens
    .map((t) => (/\s/.test(t) ? `"${t}"` : t))
    .join(" OR ");
  const trimmed = q.slice(0, 480);
  const params = new URLSearchParams({
    q: `${trimmed} when:${days}d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

export async function fetchEntityNews(
  ticker: string,
  tokens: string[],
  days = 14,
): Promise<EntityNewsResult> {
  const cutoff = Date.now() - days * 86_400_000;
  if (tokens.length === 0) {
    return {
      fetchedAt: new Date().toISOString(),
      ticker,
      items: [],
      ok: false,
      itemsFound: 0,
      redirectsResolved: 0,
    };
  }
  const url = buildGoogleNewsUrl(tokens, days);
  const xml = await fetchRss(url);
  if (xml === null) {
    return {
      fetchedAt: new Date().toISOString(),
      ticker,
      items: [],
      ok: false,
      itemsFound: 0,
      redirectsResolved: 0,
    };
  }
  const parsed = parseFeed(xml, `Google News · ${ticker}`, "wire");
  const timeFiltered = parsed.filter((i) => {
    if (!i.time) return true;
    return new Date(i.time).getTime() >= cutoff;
  });
  const redirectsResolved = await resolveGoogleNewsUrls(timeFiltered);
  return {
    fetchedAt: new Date().toISOString(),
    ticker,
    items: timeFiltered,
    ok: true,
    itemsFound: timeFiltered.length,
    redirectsResolved,
  };
}
