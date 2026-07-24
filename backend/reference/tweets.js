// /api/tweets?q=Brookfield+Corp&ticker=BN+US&limit=25
//
// Free, no-auth tweet discovery for a holding. Engines run in parallel
// and their items merge into one list under the "Tweets" filter:
//
//   1. TwitterAPI.io (if TWITTERAPI_IO_KEY set) — paid scraper service
//      that returns BOTH the holding's own posts (timeline) AND third-
//      party mentions (search). ~$0.15 / 1k tweets; with edge caching
//      that's ~$2/mo for single-user steady-state. Primary X path.
//      Auth via x-api-key header.
//   2. Nitter profile RSS — the holding's OWN tweets via ticker→handle
//      map in api/_xAccounts.js. Was rock-solid for years; as of
//      2026-06-03 most mirrors 429 / 403 / redirect. Kept as $0
//      fallback in case it (or a successor like bird.makeup) revives.
//   3. Cloudflare-Worker → DDG search (best-effort) — sometimes returns
//      x.com / twitter.com URLs, sometimes 202s. Belt-and-braces.
//   4. Bluesky public search — currently 403s every data-center IP we
//      route through; kept in case it ever unblocks.
//   5. Scraped snapshot from data/tweets.json — historical layer. The
//      cron that wrote this is disabled. Stale items merge in.
//   6. Manual paste (handled in src/storage.js, layered client-side).
//
// StockTwits + Reddit engines were removed 2026-06-03 once TwitterAPI.io
// shipped — the original use case (mention coverage when X was blocked)
// is now solved properly via X itself.
//
// If ANTHROPIC_API_KEY is set, Claude Haiku does a relevance pass to
// drop items that name-collide with the holding (e.g. "Brookfield,
// Wisconsin" vs Brookfield Corp). Off-topic items are filtered before
// returning.
//
// Free path. No paid services. Cache aggressively (Vercel CDN s-maxage)
// so upstreams aren't hammered.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDdgResults } from '../lib/ddgParser.js';
import { handleFor } from './_xAccounts.js';
import { mentionsHolding, tickerSearchTokens } from './_tickerMatch.js';
import {
  isQualityTweet,
  tweetScore,
  isLikelySpamTweet,
  isPastTimeFloor,
  matchesExclusionAlias,
  isMeaningfulMention,
} from './_tweetQuality.js';
import { getExclusionAliases } from './_entityRegistry.js';
import { stripCdata as stripCdataR } from './_html.js';
import {
  TICKER_TOPICS,
  accountsForTopics,
  topicsForQuery,
  cashtagsForTopics,
  hashtagsForTopics,
} from './_finTwitAccounts.js';

// Pre-load the scraped tweet snapshot at module load. Vercel keeps the
// function warm between invocations, so this read happens once per cold
// start and is essentially free on subsequent calls.
const SCRAPED_TWEETS = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', 'data', 'tweets.json');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
})();

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { q, ticker, limit = '75' } = req.query;
  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Missing q (search query) parameter' });
  }

  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 75, 1), 200);
  // Quote the name so the engine keeps it together — meaningful for
  // multi-word holdings ("Brookfield Corp", "Century Aluminum"). The site:
  // filter is the lever that turns this from "web search" into "tweet
  // search".
  const tweetQuery = `"${q}" (site:x.com OR site:twitter.com)`;

  // Try several engines in order. Each returns either parsed items or null
  // (meaning the engine blocked / rate-limited us, try the next one).
  // Vercel's data-center IPs get flagged harder by DDG-html than a real
  // browser does, so the fallback chain is load-bearing in production.
  //
  // DDG-POST mimics the actual <form method="post"> on duckduckgo.com and
  // tends to pass anti-bot checks that the GET endpoint trips, so it goes
  // first. Bing was tried but doesn't index x.com/twitter.com results at
  // all — pulled.
  // Engine 1 (primary, if configured): a self-hosted Cloudflare Worker
  // that proxies the DDG fetch. Worker code lives in cloudflare-worker/
  // worker.js. Set TWEET_WORKER_URL (and optionally TWEET_WORKER_SECRET)
  // on Vercel to activate it.
  //
  // Engines 2 & 3 are direct-from-Vercel attempts. They currently 403 in
  // production because of data-center IP fingerprinting, but stay as
  // belt-and-braces fallbacks for the day DDG loosens up. Public CORS
  // proxies (corsproxy.io, allorigins) were dropped — both 403'd or
  // timed out from Vercel, adding only latency.
  // Engine order: Fly proxy first (if configured) → Cloudflare Worker →
  // direct DDG attempts. Each is on a different ASN; the first one DDG
  // doesn't classify as scraper wins. The data/tweets.json snapshot
  // (committed by GitHub Actions) is layered on top of all of these via
  // the SCRAPED_TWEETS lookup further down.
  const engines = [];
  if (process.env.TWEET_FLY_URL) {
    engines.push({
      name: 'fly-proxy',
      fn: () =>
        fetchDdgViaProxy(
          tweetQuery,
          limitNum,
          process.env.TWEET_FLY_URL,
          process.env.TWEET_FLY_SECRET
        ),
    });
  }
  if (process.env.TWEET_WORKER_URL) {
    engines.push({
      name: 'cf-worker',
      fn: () =>
        fetchDdgViaProxy(
          tweetQuery,
          limitNum,
          process.env.TWEET_WORKER_URL,
          process.env.TWEET_WORKER_SECRET
        ),
    });
  }
  engines.push(
    { name: 'ddg-post', fn: () => fetchDdgPost(tweetQuery, limitNum) },
    { name: 'ddg-get',  fn: () => fetchDdg(tweetQuery, limitNum) }
  );

  // Multiple independent feeds run in parallel:
  //   - TwitterAPI.io (paid) — primary X source, profile + mentions
  //   - Nitter profile RSS — $0 fallback for own posts when alive
  //   - DDG cascade (X / Twitter via web search) — blocked everywhere
  //     in production but kept in case anything unblocks
  //   - Bluesky public search — also data-center blocked
  // Items from all sources merge into one feed under the "Tweets" UI
  // category, distinguished by platform-aware chip on each card.
  const trace = [];
  let xItems = [];
  let bskyItems = [];
  let nitterItems = [];
  let twapiItems = [];

  // Nitter profile RSS — fetches the holding's OWN tweets when we have a
  // mapping in api/_xAccounts.js. Single GET to nitter.net, no auth,
  // standard RSS 2.0 output. Profile RSS is the only Nitter endpoint
  // that still serves real content reliably (search is disabled on every
  // surviving instance). Tickers without a mapping skip this engine.
  const nitterHandle = ticker ? handleFor(ticker) : null;

  try {
    const scraped =
      ticker && SCRAPED_TWEETS[ticker] && Array.isArray(SCRAPED_TWEETS[ticker].items)
        ? SCRAPED_TWEETS[ticker]
        : null;
    const scrapedItems = scraped ? scraped.items : [];
    if (scraped) {
      trace.push({
        engine: 'scraped',
        status: 200,
        items: scrapedItems.length,
        ms: 0,
        fetchedAt: scraped.fetchedAt,
      });
    }

    const [twitter, bluesky, nitter, twapi] = await Promise.all([
      runTwitterEngines(engines, trace),
      timed(trace, 'bluesky', () => fetchBluesky(q, limitNum)),
      nitterHandle
        ? timed(trace, 'nitter', () => fetchNitter(nitterHandle, limitNum))
        : Promise.resolve([]),
      process.env.TWITTERAPI_IO_KEY
        ? timed(trace, 'twapi', () => fetchTwitterApiIo(q, nitterHandle, limitNum, ticker))
        : Promise.resolve([]),
    ]);
    xItems = twitter || [];
    bskyItems = bluesky || [];
    nitterItems = nitter || [];
    twapiItems = twapi || [];

    // Merge by URL — scraped first (most curated), then Nitter (the
    // holding's own posts, second-most curated), then auto-fetched.
    const byUrl = new Map();
    for (const it of scrapedItems) byUrl.set(it.url, it);
    for (const it of nitterItems) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    for (const it of twapiItems) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    for (const it of xItems) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    for (const it of bskyItems) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    let items = Array.from(byUrl.values());
    if (items.length === 0) {
      return res.status(200).json({
        query: q,
        ticker: ticker || null,
        count: 0,
        items: [],
        fetchedAt: new Date().toISOString(),
        coverage: 'rate-limited',
        trace,
      });
    }

    // ---- Phase 7 structural quality gates ----
    // Applied BEFORE the engagement filter so spam doesn't get a
    // free pass via "fresh + zero engagement is OK" leniency.
    //
    // 1. Hard 180-day time floor. Tweets older than this are dropped
    //    regardless of engagement. Audit found 2024-era HOYA hack
    //    tweets dominating the 2026 feed because their high
    //    engagement masked their staleness.
    // 2. Spam-pattern drop. Cashtag-stuffed lists ($KAIA $CENX $BTC
    //    pumping) and known signal-bot templates ("Jake Signals
    //    (FREE)", "Telegram: t.me/...") fail this gate even if their
    //    text length passes the engagement floor.
    // 3. Per-entity exclusion aliases. The canonical registry's
    //    exclusionAliases (Phase 0) catch the legitimate-but-wrong
    //    entity collisions: "Hoya Capital REIT" for HOYA Corp,
    //    "De La Hoya" boxer, "BolsadaAnaPaula" Portuguese fan
    //    account, "Jay-Z casino" for Western Copper, "$KAIA" for
    //    CENX, etc. One-record fix per ticker; no per-source
    //    patching.
    const nowMsEarly = Date.now();
    const tickerExclusions =
      ticker && !ticker.startsWith('theme-') && !ticker.startsWith('lookup-')
        ? getExclusionAliases(ticker)
        : [];
    const preFilterCount = items.length;
    items = items.filter((it) => {
      if (isPastTimeFloor(it, nowMsEarly)) return false;
      if (isLikelySpamTweet(it.headline || '')) return false;
      if (tickerExclusions.length > 0 && matchesExclusionAlias(it.headline || '', tickerExclusions)) {
        return false;
      }
      return true;
    });
    if (preFilterCount !== items.length) {
      console.log(
        `[tweets] structural quality drops: ${preFilterCount - items.length}/${preFilterCount} ` +
          `(time-floor + spam + exclusionAliases)`
      );
    }

    // Quality filter — drops too-short tweets, 0-engagement tweets older
    // than 2h, and tweets authored by the holding's own X handle (per
    // user request: corporate IR posts are not what they want from the
    // X feed). Tweets without an `engagement` block (manual paste,
    // extension, scraped snapshot) skip the engagement floor — there's
    // no signal to gate on.
    const companyHandle = ticker ? handleFor(ticker) : null;
    const nowMs = Date.now();
    items = items.filter((it) => {
      // Items from non-tweet sources (DDG snippets, etc.) lack `engagement`;
      // gate them on length + self-handle only.
      const opts = { now: nowMs };
      if (companyHandle) opts.companyHandle = companyHandle;
      // For items that DON'T have engagement metadata, run a relaxed
      // version of the filter: only length + self-handle. Snapshot /
      // manual / extension tweets shouldn't get dropped for missing
      // engagement.
      if (!it.engagement) {
        // Inline the length + handle check rather than ask the helper.
        if (typeof it.headline !== 'string') return false;
        const stripped = it.headline
          .replace(/https?:\/\/\S+/gi, '')
          .replace(/@\w+/g, '')
          .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
          .trim();
        if (stripped.length < 50) return false;
        if (
          companyHandle &&
          typeof it.handle === 'string' &&
          it.handle.toLowerCase() === companyHandle.toLowerCase()
        ) {
          return false;
        }
        return true;
      }
      return isQualityTweet(it, opts);
    });

    // Rank by engagement × recency. Replaces the previous pure-time-desc
    // sort so a 5h-old 12k-like tweet outranks a 30min-old 0-engagement
    // tweet. Items with no engagement metadata fall back to a pure
    // recency score inside `tweetScore`.
    items.sort((a, b) => tweetScore(b, nowMs) - tweetScore(a, nowMs));
    items = items.slice(0, limitNum);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && items.length > 0) {
      const enriched = await enrichWithClaude(items, q, ticker, apiKey);
      const byUrl = new Map(enriched.map((s) => [s.url, s]));
      items = items
        .map((it) => {
          const e = byUrl.get(it.url);
          if (!e) return it;
          return {
            ...it,
            summary: e.summary || it.summary,
            offTopic: e.offTopic === true,
          };
        })
        .filter((it) => !it.offTopic);
    }

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=1800, stale-while-revalidate=3600'
    );
    return res.status(200).json({
      query: q,
      ticker: ticker || null,
      count: items.length,
      items,
      fetchedAt: new Date().toISOString(),
      coverage: 'configured',
      sources: {
        scraped: ticker && SCRAPED_TWEETS[ticker] ? SCRAPED_TWEETS[ticker].items.length : 0,
        nitter: nitterItems.length,
        twapi: twapiItems.length,
        twitter: xItems.length,
        bluesky: bskyItems.length,
      },
      trace,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}

// =====================================================================
// Engine orchestration helpers
// =====================================================================

// Runs the DDG cascade (worker first, then direct attempts). Returns the
// list of items from the first engine that succeeds, or [] if all engines
// were blocked. Pushes per-engine status into `trace` for diagnostics.
async function runTwitterEngines(engines, trace) {
  for (const eng of engines) {
    const t0 = Date.now();
    let result;
    try {
      result = await eng.fn();
    } catch (err) {
      trace.push({ engine: eng.name, status: 'throw', error: String(err.message || err), ms: Date.now() - t0 });
      continue;
    }
    trace.push({
      engine: eng.name,
      status: result.status,
      items: result.items === null ? null : result.items.length,
      ms: Date.now() - t0,
    });
    if (result.items && result.items.length > 0) return result.items;
    if (result.status === 200) return []; // engine reachable but no hits
  }
  return null; // every engine blocked
}

// Small wrapper that records timing+result of a single async call into
// the shared trace array.
async function timed(trace, name, fn) {
  const t0 = Date.now();
  try {
    const items = await fn();
    trace.push({ engine: name, status: 200, items: items.length, ms: Date.now() - t0 });
    return items;
  } catch (err) {
    trace.push({ engine: name, status: 'throw', error: String(err.message || err), ms: Date.now() - t0 });
    return [];
  }
}

// =====================================================================
// Bluesky: public search API, free, no auth required
// =====================================================================
//
// AT Proto exposes `app.bsky.feed.searchPosts` as a JSON endpoint at
// public.api.bsky.app. Returns an array of `posts` with author, text,
// timestamp, and counts. Convert each into the same item shape the DDG
// path produces so the front-end doesn't have to branch.
//
// Bluesky's FinTwit cohort is much smaller than X's, but for some
// holdings (commodities, macro names) the coverage is real — and the
// API doesn't fight back the way DDG does.

async function fetchBluesky(query, limit) {
  // Bluesky search supports phrase queries with quotes — the same trick
  // we use for DDG ("Brookfield Corp" vs Brookfield) cuts false positives
  // from unrelated places with similar names.
  const q = `"${query}"`;

  // public.api.bsky.app 403s data-center IPs in production. Try the Fly
  // proxy first (if configured), then the Cloudflare Worker — first one
  // whose egress IP Bluesky doesn't block wins. Last-ditch direct call
  // is mostly for local dev where the caller IS residential.
  let proxyUrl = process.env.TWEET_FLY_URL || process.env.TWEET_WORKER_URL || null;
  const proxySecret = proxyUrl === process.env.TWEET_FLY_URL
    ? process.env.TWEET_FLY_SECRET
    : process.env.TWEET_WORKER_SECRET;
  const url = proxyUrl
    ? `${proxyUrl.replace(/\/$/, '')}/?bsky=${encodeURIComponent(q)}`
    : `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 25)}&sort=latest`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; BluOrNewsTracker/1.0)',
    Accept: 'application/json',
  };
  if (proxyUrl && proxySecret) headers['X-Auth'] = proxySecret;

  const r = await fetch(url, { headers });
  if (!r.ok) {
    throw new Error(`Bluesky ${r.status}`);
  }
  const data = await r.json();
  if (!Array.isArray(data?.posts)) return [];
  return data.posts.map(toBlueskyItem).filter((it) => it.url && it.headline);
}

// =====================================================================
// Small XML helpers — shared with the Nitter RSS parser. Previously
// also fed the Reddit Atom parser (removed 2026-06-03).
// =====================================================================

function matchTag(c, tag) {
  const m = c.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

// =====================================================================
// Nitter profile RSS — the one X-tweet path that still actually works.
// =====================================================================
//
// Every other unauthenticated X read path is dead: syndication.twitter.com
// connection-resets, every public Nitter search endpoint is either disabled
// or anti-bot, Bluesky 403s data-center IPs, cookie-authenticated GraphQL
// rotates queryIds every few weeks and bans throwaway accounts. What does
// keep working is the single per-profile RSS feed nitter.net serves at
// /<handle>/rss — stable for years, no auth, ~20 items including retweets,
// real timestamps, real text. We map ticker → handle in api/_xAccounts.js.
//
// This engine only covers the HOLDING'S OWN tweets. Third-party mentions
// of the holding are now handled by the TwitterAPI.io engine's
// advanced_search call (see fetchTwitterApiIo below) plus manual paste.
//
// If nitter.net itself ever dies, swap NITTER_HOST below for another
// instance that still serves profile RSS (verify with curl first — most
// surviving instances now serve anti-bot challenges instead of RSS).

const NITTER_HOST = 'nitter.net';

async function fetchNitter(handle, limit) {
  if (!handle) return [];
  // Vercel's egress IPs are TCP-rejected by nitter.net's host (verified
  // via /api/probe-tweets: "fetch failed" in <400ms). Route through the
  // Cloudflare Worker when configured — Cloudflare's anycast egress is
  // one of the few free paths nitter.net still serves. Falls back to a
  // direct fetch for local dev where the caller IS residential.
  const workerUrl = process.env.TWEET_WORKER_URL;
  const workerSecret = process.env.TWEET_WORKER_SECRET;
  const headers = {
    Accept: 'application/rss+xml, application/xml, text/xml',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  };
  let url;
  if (workerUrl) {
    url = `${workerUrl.replace(/\/$/, '')}/?nitter=${encodeURIComponent(handle)}`;
    if (workerSecret) headers['X-Auth'] = workerSecret;
  } else {
    url = `https://${NITTER_HOST}/${encodeURIComponent(handle)}/rss`;
  }
  const r = await fetch(url, { headers });
  if (!r.ok) {
    // 404 = wrong handle (account renamed/deleted); 429 = rate-limited.
    // Either way, no items — just return [] so the rest of the pipeline
    // runs. The trace records the status for diagnostics.
    if (r.status === 404 || r.status === 429) return [];
    throw new Error(`Nitter ${r.status}`);
  }
  const xml = await r.text();
  return parseNitterRss(xml, handle, limit);
}

function parseNitterRss(xml, ownerHandle, limit) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && out.length < limit) {
    const c = m[1];
    const title = stripCdataR(matchTag(c, 'title'));
    const link = stripCdataR(matchTag(c, 'link'));
    const pub = stripCdataR(matchTag(c, 'pubDate'));
    const creator = stripCdataR(matchTag(c, 'dc:creator')).replace(/^@/, '');
    if (!title || !link) continue;

    // Nitter item links look like https://nitter.net/<author>/status/<id>#m
    // — the #m anchor is harmless but we drop it. Convert host → x.com
    // so users click through to the real platform.
    const u = link.match(
      /^https?:\/\/[^/]+\/([A-Za-z0-9_]+)\/status\/(\d+)/i
    );
    if (!u) continue;
    const tweetHandle = u[1];
    const tweetId = u[2];
    const xUrl = `https://x.com/${tweetHandle}/status/${tweetId}`;

    // dc:creator is the actual author for retweets (Nitter's <title> on
    // retweets is prefixed "RT by @owner: ..."); falling back to the URL
    // handle covers original tweets where dc:creator is missing.
    const sourceHandle = creator || tweetHandle;
    const text = title.replace(/\s+/g, ' ').trim();
    out.push({
      headline: text.length > 280 ? text.slice(0, 277) + '...' : text,
      url: xUrl,
      source: `@${sourceHandle}`,
      time: pub ? safeIsoDate(pub) : null,
      summary: '',
      articleType: 'tweet',
      platform: 'twitter',
      handle: sourceHandle,
      kind: 'status',
    });
  }
  return out;
}

// =====================================================================
// TwitterAPI.io — paid scraper service. Activated when TWITTERAPI_IO_KEY
// is set. Two endpoints per call:
//   - GET /twitter/user/last_tweets?userName=<handle>
//       The holding's own posts. Requires a mapping in api/_xAccounts.js.
//   - GET /twitter/tweet/advanced_search?query="<name>"&queryType=Latest
//       Third-party mentions of the company. Runs for every holding.
// Free tier rate-limits to 1 req/5s; we fire both calls in parallel and
// accept that one may 429 — the trace records it, the page still renders
// from whichever succeeded (and from the other engines).
//
// Pricing reminder: $0.15 / 1k tweets returned (100k credits = $1, ~15
// credits/tweet). On-demand with 30-min edge cache → ~$2/mo single-user.
// =====================================================================

// Max FinTwit accounts polled per request. Each account is one
// last_tweets call (~$0.0003 returned worth of tweets). Capped so the
// fan-out cost stays bounded.
const MAX_FINTWIT_ACCOUNTS = 40;

// Helpers to call TwitterAPI.io's two endpoints.
async function fetchUserTweets(userName, headers) {
  try {
    const r = await fetch(
      `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(userName)}`,
      { headers }
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.data?.tweets || []).map((t) => ({ ...t, _defaultHandle: userName }));
  } catch {
    return [];
  }
}

async function fetchAdvancedSearch(tokens, headers) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const queryStr = tokens
    .map((t) => (t.includes(' ') ? `"${t.replace(/"/g, '')}"` : t))
    .join(' OR ');
  try {
    const r = await fetch(
      `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(
        queryStr
      )}&queryType=Latest`,
      { headers }
    );
    if (!r.ok) return [];
    const j = await r.json();
    return j?.tweets || [];
  } catch {
    return [];
  }
}

// Split the holding's search tokens into two complementary groups so we
// can fire two parallel advanced_search variants instead of one OR'd
// blob. Empirically, FinTwit splits into two distinct audiences —
// cashtag-users ($BN, $TGB.TO) write in shorthand, name-writers
// ("Brookfield announces…") write formally. One blended query
// undersamples both groups; two focused queries oversample each.
function splitSearchTokens(ticker, query) {
  const all = ticker ? tickerSearchTokens(ticker, { name: query }) : [];
  const cashtags = all.filter((t) => /^\$/.test(t) || /\./.test(t));
  const names = all.filter((t) => !cashtags.includes(t));
  return {
    cashtagTokens: cashtags.slice(0, 5),
    nameTokens: names.slice(0, 5),
  };
}

async function fetchTwitterApiIo(query, handle, limit, ticker) {
  const key = process.env.TWITTERAPI_IO_KEY;
  if (!key) return [];
  const headers = {
    'x-api-key': key,
    Accept: 'application/json',
  };

  // ---- 1. Profile poll — the holding's own X account, if mapped ----
  // We still pull these even though the quality filter drops the
  // company's self-tweets, because the dedup map needs them populated
  // so a third-party retweet of a company post doesn't surface as
  // standalone.
  const profilePromise = handle
    ? fetchUserTweets(handle, headers)
    : Promise.resolve([]);

  // ---- 2. Multi-variant advanced_search ----
  const { cashtagTokens, nameTokens } = splitSearchTokens(ticker, query);
  const searchPromises = [];
  if (cashtagTokens.length > 0) {
    searchPromises.push(fetchAdvancedSearch(cashtagTokens, headers));
  }
  if (nameTokens.length > 0) {
    searchPromises.push(fetchAdvancedSearch(nameTokens, headers));
  }
  // No ticker (theme / lookup) — fall back to a single query of the
  // raw search string. Quote it so multi-word phrases stay intact.
  if (searchPromises.length === 0 && query) {
    searchPromises.push(fetchAdvancedSearch([query], headers));
  }
  // Theme / lookup extra variants — sector ETF cashtags + topical
  // hashtags catch tweets that don't write the topic word verbatim
  // ($COPX as copper shorthand, #goldbugs in gold circles, etc.).
  const isThemeOrLookup =
    !ticker ||
    (typeof ticker === 'string' &&
      (ticker.startsWith('theme-') || ticker.startsWith('lookup-')));
  if (isThemeOrLookup) {
    const themeTopics = topicsForQuery(query);
    const expansionTokens = [
      ...cashtagsForTopics(themeTopics),
      ...hashtagsForTopics(themeTopics),
    ];
    if (expansionTokens.length > 0) {
      searchPromises.push(
        fetchAdvancedSearch(expansionTokens.slice(0, 6), headers)
      );
    }
  }

  // ---- 3. FinTwit fan-out ----
  // Topics for the request: per-ticker map for known holdings, keyword
  // sniff on the query for themes / Quick Look Up. Cap to N accounts
  // to bound cost — list is hand-ordered so the top-N are the most
  // high-signal.
  const topics =
    ticker && TICKER_TOPICS[ticker]
      ? TICKER_TOPICS[ticker]
      : topicsForQuery(query);
  const finTwitHandles = accountsForTopics(topics).slice(0, MAX_FINTWIT_ACCOUNTS);
  const finTwitPromise = Promise.all(
    finTwitHandles.map((h) => fetchUserTweets(h, headers))
  ).then((arrs) => arrs.flat());

  const [profileTweets, finTwitTweets, ...searchResults] = await Promise.all([
    profilePromise,
    finTwitPromise,
    ...searchPromises,
  ]);
  const mentionTweets = searchResults.flat();

  // ---- Merge by tweet id ----
  // Order: profile-first, then mentions, then FinTwit. First write
  // wins so a tweet that surfaces in multiple lists keeps its richest
  // metadata (the profile-call response carries the cleanest user
  // object; advanced_search sometimes returns abbreviated user info).
  const byId = new Map();
  for (const t of profileTweets) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  for (const t of mentionTweets) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  for (const t of finTwitTweets) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);

  let merged = Array.from(byId.values());

  // ---- Relevance filter ----
  // Mentions + FinTwit results: must actually reference the holding /
  // theme. Profile-account posts pass through (we still want them
  // populated so the dedup map is honest; the company-self-tweet
  // drop happens later in the quality filter).
  //
  // Phase 7: replaced raw mentionsHolding with isMeaningfulMention.
  // The wrapper layers two structural checks on top:
  //   - if the tweet is cashtag-stuffed AND the entity is only
  //     referenced via its bare cashtag (no name / alias in prose),
  //     reject — that's list inclusion, not a real mention. Fixes the
  //     audit's CENX-in-$KAIA-pump-list pattern.
  //   - exclusionAliases from the registry are honored — drops
  //     "Hoya Capital REIT" tweets from the HOYA Corp feed, etc.
  if (ticker && !ticker.startsWith('theme-') && !ticker.startsWith('lookup-')) {
    const exclusions = getExclusionAliases(ticker);
    merged = merged.filter((t) => {
      const text = t.text || '';
      // Self-account passthrough still applies — corporate IR account
      // posts go through to the dedup map; the corp-self-tweet drop
      // is a downstream concern in isQualityTweet.
      if (handle && (t.author?.userName || '').toLowerCase() === handle.toLowerCase()) {
        return true;
      }
      // exclusionAliases backstop: drops named collisions before the
      // mention check even runs.
      if (exclusions.length > 0 && matchesExclusionAlias(text, exclusions)) {
        return false;
      }
      return isMeaningfulMention(text, ticker, mentionsHolding, { name: query });
    });
  } else if (query) {
    // Theme / lookup — relevance filter. Previous threshold required
    // ≥2 distinct query-word hits per tweet, which strangled hot
    // themes: a tweet "Tanker seized in Hormuz" only hits 'hormuz'
    // so failed the 2-word floor.
    //
    // New: extract ONLY the theme NAME words (the bare-word AND'd
    // section of buildThemeSearchQuery, or the first quoted phrase
    // for short names). Skip the OR-group type-default keywords —
    // those bleed into the query but match generic tweets ("Apple
    // price target") that aren't on-topic.
    //
    // Threshold: ≥1 name-word hit. Tweets are short; one specific
    // term is the realistic match. FinTwit fan-out is already
    // topic-filtered upstream (only accounts with topic-affinity to
    // the theme are polled), so a single Hormuz mention from a
    // commodities-tagged FinTwit account is high signal.
    const nameWords = extractThemeNameWords(query);
    if (nameWords.length > 0) {
      merged = merged.filter((t) => {
        const text = (t.text || '').toLowerCase();
        return nameWords.some((w) => text.includes(w));
      });
    }
  }

  // Expand the pool a bit before quality filtering — give isQualityTweet
  // a wider candidate set to choose from. The final slice happens in
  // the handler.
  return merged.slice(0, limit * 3).map(toTwitterApiItem);
}

function toTwitterApiItem(t) {
  const handle = t.author?.userName || t._defaultHandle || '';
  const text = (t.text || '').replace(/\s+/g, ' ').trim();
  const id = t.id;
  const url =
    t.twitterUrl ||
    t.url ||
    (handle && id ? `https://x.com/${handle}/status/${id}` : null);
  // TwitterAPI.io response field naming for engagement counters. Defaults
  // to 0 when absent so downstream code doesn't have to null-check.
  const engagement = {
    likes: Number(t.likeCount || t.favoriteCount || 0),
    retweets: Number(t.retweetCount || 0),
    replies: Number(t.replyCount || 0),
    views: Number(t.viewCount || 0),
  };
  return {
    headline: text.length > 280 ? text.slice(0, 277) + '...' : text,
    engagement,
    url,
    source: handle ? `@${handle}` : 'X',
    time: t.createdAt ? safeIsoDate(t.createdAt) : null,
    summary: '',
    articleType: 'tweet',
    platform: 'twitter',
    handle,
    kind: 'status',
  };
}

// Extract the theme NAME words from a constructed Google News
// query. buildThemeSearchQuery emits one of two shapes:
//
//   "Strait of Hormuz" ("price" OR "market" OR ...)    — short name (quoted)
//   brazil fiscal policy ("policy" OR ...)             — long name (bare words)
//
// Either way, the name comes FIRST. The rest is OR-group keywords
// (type defaults or user-supplied), which we ignore — they're too
// generic to use as tweet-text relevance signals on their own.
//
// Returns lowercased words ≥3 chars (drops stopwords like 'of', 'a').
function extractThemeNameWords(query) {
  if (!query || typeof query !== 'string') return [];
  const STOPLIKE = new Set([
    'the','and','for','site','when','before','after','about','from','that',
    'this','your','will','have','with','into','their','them','then','than',
    'also','been','were','was','are','its','was','its','of','an','a','to',
    'in','on','at','by','as','is','be','or','but',
  ]);
  let nameSection;
  const quotedMatch = query.match(/^\s*"([^"]+)"/);
  if (quotedMatch) {
    nameSection = quotedMatch[1];
  } else {
    // Take everything before the first opening paren or quote.
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

function safeIsoDate(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toBlueskyItem(post) {
  const handle = post.author?.handle || '';
  // AT URIs look like at://did:plc:.../app.bsky.feed.post/<rkey>; the
  // rkey is the last path segment. Convert to the web URL the user can
  // click through to.
  const uri = post.uri || '';
  const rkey = uri.split('/').pop() || '';
  const webUrl =
    handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
  const text = (post.record?.text || '').trim();
  return {
    headline: text.length > 220 ? text.slice(0, 217) + '...' : text,
    url: webUrl,
    source: `@${handle}`,
    time: post.record?.createdAt || post.indexedAt || null,
    summary: '',
    articleType: 'tweet',
    platform: 'bluesky',
    handle,
    kind: 'status',
  };
}

// =====================================================================
// Engine adapters — each returns { items, status }. `items` is null when
// the engine blocked us (so the caller knows to try the next one);
// `items` is [] when the engine is reachable but had no hits.
// =====================================================================

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// DDG via POST — the form on duckduckgo.com submits this way, and DDG's
// anti-bot tends to greenlight POSTs that match the real form. Verified
// 200 from local with the same Vercel-flagged setup.
async function fetchDdgPost(query, limit) {
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://duckduckgo.com/',
      Origin: 'https://duckduckgo.com',
    },
    body: new URLSearchParams({ q: query, b: '' }).toString(),
  });
  if (!r.ok) return { items: null, status: r.status };
  const html = await r.text();
  return { items: parseDdgResults(html, limit), status: r.status };
}

async function fetchDdg(query, limit) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Referer: 'https://duckduckgo.com/' },
  });
  if (!r.ok) return { items: null, status: r.status };
  const html = await r.text();
  return { items: parseDdgResults(html, limit), status: r.status };
}

// Generic "ask a proxy to fetch DDG for us" — used for both the Cloudflare
// Worker and the Fly.io proxy, since they expose the same endpoint shape
// (?q=<query>, optional X-Auth header). The proxy handles the IP-
// reputation problem; we just GET its URL and parse the HTML returned.
async function fetchDdgViaProxy(query, limit, proxyUrl, authSecret) {
  const target = `${proxyUrl.replace(/\/$/, '')}/?q=${encodeURIComponent(query)}`;
  const headers = {};
  if (authSecret) headers['X-Auth'] = authSecret;
  const r = await fetch(target, { headers });
  if (!r.ok) return { items: null, status: r.status };
  const html = await r.text();
  return { items: parseDdgResults(html, limit), status: r.status };
}

// DDG HTML result parser lives in lib/ddgParser.js — shared with
// scripts/scrape-tweets.mjs (the GitHub Actions cron) so both code paths
// see the same shape.

// =====================================================================
// Claude relevance filter
// =====================================================================

async function enrichWithClaude(items, companyName, ticker, apiKey) {
  const prompt = `You are an analyst at BluOr Asset Management. Each line below is a tweet or X profile that web-search returned when looking for "${companyName}"${ticker ? ` (${ticker})` : ''}. Tweet-search is noisy — many results are about unrelated companies or places with similar names (e.g. "Brookfield, Wisconsin"; "Brookfield Engineering"; people named "Capstone"; the village of "Source", Wyoming).

For EACH item below, do TWO things:

1. SUMMARY: 1 sentence describing what this tweet/profile is about, focused on the ${ticker || companyName} angle if there is one. Be neutral and factual.

2. OFF-TOPIC flag: set "offTopic": true if this item is clearly NOT about the holding (different company, different place, different person, unrelated context). Set "offTopic": false if it IS about the holding or its industry. When in doubt, set false.

Return STRICT JSON only — no markdown fences, no preamble:
[{"url":"...","summary":"...","offTopic":true|false}]

Items:
${items
  .map(
    (it, i) =>
      `${i + 1}. [${it.source}] ${it.headline}\n   URL: ${it.url}`
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
    if (!r.ok) {
      return items.map((it) => ({ url: it.url, summary: '', offTopic: false }));
    }
    const data = await r.json();
    const text = data?.content?.[0]?.text || '';
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return items.map((it) => ({ url: it.url, summary: '', offTopic: false }));
    }
    return parsed.map((p) => ({
      url: p.url,
      summary: typeof p.summary === 'string' ? p.summary : '',
      offTopic: p.offTopic === true,
    }));
  } catch {
    return items.map((it) => ({ url: it.url, summary: '', offTopic: false }));
  }
}
