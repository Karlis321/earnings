// /api/must-reads
// POST { queries: Array<{ q: string, ticker: string }> }
//
// Builds TWO pools from the same fan-out:
//   - items   — curated Must-Reads top 7. Per-ticker capped for diversity,
//               opinion-filtered, with a +0.5 score bonus on press releases so
//               material disclosures float to the top. Bounded only by what
//               upstream sources return (Google News RSS ~7-30 days, EDGAR
//               years).
//   - recent  — Most-Recents: every materialised item in strict chronological
//               order, capped at 200. Opinion-filtered but no per-ticker cap
//               and no recency scoring — pure timeline. The home page applies
//               a client-side time-range filter on top of this, so the server
//               returns a wide pool and the client picks the slice the user
//               selected (24h, 48h, 3d, 7d, 30d, 60d, or all-time).
//
// Claude Haiku enrichment runs ONCE on the union of both pools, so both lists
// share its summaries, translations, and news/opinion classifications.
// The tier-4-source filter (TipRanks/Motley Fool/etc.) is applied client-side
// in Home.jsx for both lists; no cross-bundle import needed here.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOfficialSources } from './_feedFetcher.js';
import { stripCdata, extractTag, decodeHtmlEntities } from './_html.js';
import {
  searchBing,
  searchHackerNews,
  searchEdgar,
  searchThinkTanks,
} from './_searchEngines.js';
import { looksLikeJunkPage } from './_urlFilters.js';
import { tagItem } from './_itemTagger.js';

// Pre-baked news snapshot — written by scripts/cache-news.mjs via the
// cache-news GitHub Actions cron every 30 min. Acts as a fallback
// layer: when the live Google News fetch comes back thin (rate-
// limited / 429 / empty channel), we merge in the snapshot so the
// page never goes blank. Vercel keeps the function warm so this read
// happens once per cold start.
const CACHED_NEWS_SNAPSHOT = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', 'data', 'cached-news.json');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { items: [], fetchedAt: null, totalItems: 0 };
  }
})();

// Threshold below which we merge in the cached snapshot. When the
// live fan-out returns at least this many UNIQUE items (post-dedup),
// the live result is considered healthy and the snapshot is not
// merged (avoiding a 2000-item flood through Claude's enrichment
// budget on a healthy day). Below this, we top up from the cache.
const LIVE_HEALTH_THRESHOLD = 80;

const RECENCY_WEIGHTS = [
  { maxHours: 24, weight: 1.0 },
  { maxHours: 24 * 7, weight: 0.7 },
  { maxHours: 24 * 30, weight: 0.4 },
  { maxHours: Infinity, weight: 0.2 },
];

// Additive score bonus for official press releases. Sized so that ANY PR
// — even a year-old 8-K with recency weight 0.2 — outranks the freshest
// editorial news (today's = 1.0). 1.5 + 0.2 = 1.7 > 1.0. The user
// explicitly wants older PRs to surface in Must-Reads at "All time".
const PR_SCORE_BONUS = 1.5;

// Diversity cap — items per ticker into the Claude-enriched candidate
// pool. Bumped 12 → 40 so each holding gets a fatter slice before the
// MUST_READS_CANDIDATE_CAP score ranking trims.
const PER_TICKER_CAP = 40;

// How many Must-Reads candidates the server returns. Bumped 100 → 300
// so "All time" reveals a deeper history before the client-side
// range filter trims.
const MUST_READS_OUTPUT_CAP = 300;

// Pre-enrichment candidate pool size. Bumped 200 → 800 to give the
// score ranking more room before diversity + recency squeeze items
// out at long ranges.
const MUST_READS_CANDIDATE_CAP = 800;

// Most-Recents cap. Raised 5000 → 15000 so portfolios with deep
// premium-host fan-out (WSJ / Bloomberg / FT / Reuters / Economist /
// CNBC / MarketWatch / Barron's / NYT / Forbes per entity) don't
// truncate before the client-side filters grade.
const RECENT_CAP = 15000;

// Per-query upstream caps. Google News RSS returns up to ~100 items
// per query (their hard limit, not ours). Official-feed registry
// entries (per Bloomberg ticker) raised 100 → 200 to expose more
// historical filings.
const GOOGLE_NEWS_PER_QUERY = 100;
const OFFICIAL_PER_QUERY = 200;

// Date-bucket suffixes appended to theme + stock queries. Google News
// biases hard toward recent results; firing the same query with
// `when:1y` / `when:5y` pulls in different historical snapshots that
// dedup into a much larger pool. Empty bucket = bare query (most-
// recent).
const DATE_BUCKETS = ['', 'when:1y', 'when:5y'];

// Premium news sites we ALWAYS poll for every theme query, in addition
// to the bare Google News search. Each adds one Google News query with
// a `site:` constraint — the result is that theme content reliably
// includes coverage from these publications even when the bare-keyword
// search doesn't surface them prominently. Each yields ~10-30 items
// per theme, so a 5-theme portfolio adds ~50 queries × ~20 items =
// ~1000 premium items to the pool before dedupe + per-entity cap.
//
// Hostnames only (no path) — they feed straight into Google News'
// `site:` operator. Edit the list to shift the editorial mix.
const PREMIUM_HOSTS_FOR_THEMES = [
  'bloomberg.com',
  'wsj.com',
  'ft.com',
  'reuters.com',
  'economist.com',
  'cnbc.com',
  'marketwatch.com',
  'barrons.com',
  'nytimes.com',
  'forbes.com',
];

// Per-entity rebalancing now happens client-side (Home.jsx filterRecent),
// where we have access to classifySource and can rank by tier within an
// entity. The server just returns the dedup'd time-sorted pool up to
// RECENT_CAP; the client takes the best N per ticker / theme by
// (tier asc, time desc) before render.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const queries = Array.isArray(body.queries)
    ? body.queries.filter((x) => x && typeof x.q === 'string' && x.q.length > 0)
    : [];

  if (queries.length === 0) {
    return res.status(400).json({ error: 'No queries provided' });
  }

  // Stocks have Bloomberg tickers ("BN US", "7741 JP"); themes &
  // lookups carry synthetic ids ("theme-...", "lookup-..."). The IR
  // feed registry is keyed by Bloomberg ticker only — themes/lookups
  // have no filings to poll.
  const isThemeQuery = (t) =>
    typeof t === 'string' && (t.startsWith('theme-') || t.startsWith('lookup-'));

  const expandedNewsQueries = [];
  for (const q of queries) {
    // Base query — fan out across date buckets to expose historical
    // content beyond Google News' default recency bias. Applies to
    // stocks AND themes so "All time" actually reveals years of
    // material instead of just the past ~48 h.
    for (const bucket of DATE_BUCKETS) {
      expandedNewsQueries.push({
        ...q,
        q: bucket ? `${q.q} ${bucket}` : q.q,
      });
    }
    // Premium-host expansion: applies to EVERY query unless flagged
    // `skipHostExpand`. Originally gated to theme / lookup queries
    // only — that left the home Most Recent feed without WSJ /
    // Bloomberg / FT / Reuters coverage for portfolio stocks, even
    // though those publishers regularly cover the holdings. We don't
    // date-bucket the premium-host variants — that'd 3× the call
    // count for marginal benefit (premium hosts publish recent
    // content; their archives surface via the base date-bucket runs).
    if (q.skipHostExpand !== true) {
      for (const host of PREMIUM_HOSTS_FOR_THEMES) {
        expandedNewsQueries.push({ ...q, q: `${q.q} site:${host}` });
      }
    }
  }

  // Official-feed registry is keyed by Bloomberg ticker — only stocks
  // need polling there. Themes / lookups don't have IR feeds.
  const stockQueries = queries.filter(
    (q) => !isThemeQuery(q.ticker)
  );

  // Multi-engine fan-out for the BASE queries (one call per entity
  // per engine, NOT per expanded variant — those would balloon to
  // 5× engines × 100+ variants). For each entity we fire Bing + HN +
  // EDGAR + Think-tanks in parallel. GDELT is intentionally skipped
  // in must-reads (1 req / 5 sec rate limit doesn't tolerate 20
  // parallel entities) — it stays on the per-entity /api/news path
  // and on the cron pre-fetch where calls can be serialised.
  const multiEngineQueries = queries.filter((q) => q && typeof q.q === 'string' && q.q.trim());

  // Fan out:
  //   - Google News (expanded date buckets + premium hosts)
  //   - IR-feed registry (stocks only)
  //   - Bing News (per-entity)
  //   - Hacker News Algolia (per-entity)
  //   - SEC EDGAR (per-entity)
  //   - Think-tank RSS bundle (per-entity, internally cached for 15 min)
  const [
    newsResults,
    prResults,
    bingResults,
    hnResults,
    edgarResults,
    thinkTankResults,
  ] = await Promise.all([
    Promise.all(expandedNewsQueries.map(fetchGoogleNewsForQuery)),
    Promise.all(stockQueries.map(fetchOfficialForQuery)),
    Promise.all(
      multiEngineQueries.map((q) =>
        searchBing(q.q, { limit: 150 })
          .catch(() => [])
          .then((items) => ({ ticker: q.ticker, q: q.q, items, engine: 'bing' }))
      )
    ),
    Promise.all(
      multiEngineQueries.map((q) =>
        searchHackerNews(q.q, { limit: 100 })
          .catch(() => [])
          .then((items) => ({ ticker: q.ticker, q: q.q, items, engine: 'hn' }))
      )
    ),
    Promise.all(
      multiEngineQueries.map((q) =>
        searchEdgar(q.q, { limit: 100 })
          .catch(() => [])
          .then((items) => ({ ticker: q.ticker, q: q.q, items, engine: 'edgar' }))
      )
    ),
    Promise.all(
      multiEngineQueries.map((q) =>
        searchThinkTanks(q.q, { limit: 60 })
          .catch(() => [])
          .then((items) => ({ ticker: q.ticker, q: q.q, items, engine: 'thinktank' }))
      )
    ),
  ]);

  const now = Date.now();
  const byUrl = new Map();
  // Headline dedupe — same article syndicated across Reuters / Yahoo /
  // Bloomberg appears as separate URLs but the same normalised
  // headline. First write wins; later items with the same headline
  // get merged into the existing record's ticker set so the chip row
  // still shows every entity that surfaced it.
  const byHeadline = new Map();
  let upstreamErrors = 0;
  let prItemsTotal = 0;

  for (const r of [
    ...newsResults,
    ...prResults,
    ...bingResults,
    ...hnResults,
    ...edgarResults,
    ...thinkTankResults,
  ]) {
    if (r.error) upstreamErrors++;
    for (const rawItem of r.items) {
      // Phase 2 (inert): attach mentionedEntities / topics / sourceTier
      // / articleShape to every item before dedup. Tags are
      // observational only in Phase 2 — score/filter logic below is
      // unchanged. The tags ride through onto the surviving record
      // (first-write-wins dedup means later duplicates' tags are
      // ignored, which is fine because the tags are deterministic
      // functions of headline + source — duplicates would produce
      // identical tags anyway).
      const item = tagItem(rawItem, { originatingTicker: r.ticker || null });
      const dt = item.time ? new Date(item.time) : null;
      const ageHours = dt
        ? (now - dt.getTime()) / 3600000
        : Number.POSITIVE_INFINITY;
      const recency =
        RECENCY_WEIGHTS.find((w) => ageHours < w.maxHours)?.weight ?? 0.2;
      const isPR = item.articleType === 'press-release';
      if (isPR) prItemsTotal++;
      const score = recency + (isPR ? PR_SCORE_BONUS : 0);

      // Two-key dedupe: same URL OR same normalised headline. The
      // URL key catches obvious dupes (one article fetched via two
      // upstream queries). The headline key catches syndication —
      // Reuters/Bloomberg/Yahoo Finance publish the same article
      // under different URLs but identical headlines, and seeing
      // three cards for the same story is what the user complained
      // about. First-seen wins for headline matches; subsequent
      // copies fold their ticker into the existing record.
      const headlineKey = normalizeHeadline(item.headline);
      const existingByUrl = byUrl.get(item.url);
      const existingByHeadline = headlineKey ? byHeadline.get(headlineKey) : null;
      const existing = existingByUrl || existingByHeadline;
      if (existing) {
        if (r.ticker) existing.tickers.add(r.ticker);
        if (r.q) existing.companyNames.add(r.q);
        existing.score = Math.max(existing.score, score);
        // If the existing record was a Google-News editorial copy and
        // we now have the same headline/URL as an official PR,
        // upgrade it.
        if (isPR && existing.articleType !== 'press-release') {
          existing.articleType = 'press-release';
          existing.provenance = item.provenance;
          existing.sourceLabel = item.sourceLabel;
          existing.headline = item.headline || existing.headline;
        }
      } else {
        const record = {
          headline: item.headline,
          url: item.url,
          source: item.source,
          time: item.time,
          summary: item.summary || '',
          articleType: isPR ? 'press-release' : null,
          provenance: item.provenance || null,
          sourceLabel: item.sourceLabel || null,
          translate: item.translate || null,
          tickers: new Set(r.ticker ? [r.ticker] : []),
          companyNames: new Set(r.q ? [r.q] : []),
          score,
          // Phase 2 (inert) tags. Pass through unchanged so Phase 3's
          // relevance gate can read them without re-tagging.
          mentionedEntities: item.mentionedEntities || [],
          topics: item.topics || [],
          sourceTier: item.sourceTier ?? null,
          articleShape: item.articleShape || 'news',
        };
        byUrl.set(item.url, record);
        if (headlineKey) byHeadline.set(headlineKey, record);
      }
    }
  }

  // ----------------------------------------------------------------
  // Failover layer — merge in the cached snapshot when live results
  // are thin.
  //
  // Why
  // ===
  // Google News occasionally rate-limits Vercel egress (429) or
  // returns an empty channel. Pre-this-layer, that meant a blank
  // home page. The cron in scripts/cache-news.mjs writes a snapshot
  // every 30 min so we always have content within ~30 minutes of
  // fresh; this block layers it on top of the live result when the
  // live count is below LIVE_HEALTH_THRESHOLD. The dedup map handles
  // overlaps: items already surfaced live keep their live record,
  // snapshot fills only the gaps.
  //
  // Cached items are tagged `cached: true` and assigned an artificial
  // score so they rank BELOW live items at equal recency — even when
  // the cache is doing the heavy lifting, fresh-fetched stuff floats
  // to the top.
  // ----------------------------------------------------------------
  const liveCount = byUrl.size;
  let cachedItemsMerged = 0;
  if (
    liveCount < LIVE_HEALTH_THRESHOLD &&
    Array.isArray(CACHED_NEWS_SNAPSHOT.items) &&
    CACHED_NEWS_SNAPSHOT.items.length > 0
  ) {
    // Only consider snapshot items tagged with at least one ticker
    // the caller asked about — saves us from flooding the dedup map
    // with content for entities outside the current request.
    const queriedTickers = new Set(queries.map((q) => q.ticker).filter(Boolean));
    for (const rawCachedItem of CACHED_NEWS_SNAPSHOT.items) {
      const tickers = Array.isArray(rawCachedItem.tickers) ? rawCachedItem.tickers : [];
      if (tickers.length === 0) continue;
      if (queriedTickers.size > 0 && !tickers.some((t) => queriedTickers.has(t))) {
        continue;
      }
      // Tag cached items too — until the next cron run writes a
      // tagged snapshot, pre-Phase-2 snapshots arrive untagged here.
      // Re-tagging is cheap and idempotent (deterministic from
      // headline + source).
      const item = tagItem(rawCachedItem);
      // Headline + URL dedup against live results — if we already
      // have it live, merge in any extra tickers and skip.
      const headlineKey = normalizeHeadline(item.headline);
      const existing =
        byUrl.get(item.url) ||
        (headlineKey ? byHeadline.get(headlineKey) : null);
      if (existing) {
        for (const t of tickers) existing.tickers.add(t);
        continue;
      }
      const dt = item.time ? new Date(item.time) : null;
      const ageHours = dt
        ? (now - dt.getTime()) / 3600000
        : Number.POSITIVE_INFINITY;
      const recency =
        RECENCY_WEIGHTS.find((w) => ageHours < w.maxHours)?.weight ?? 0.2;
      // -0.05 penalty so a cached item with same recency as a live
      // item still ranks below it. PRs (from live fetch) keep the
      // +1.5 bonus and easily outrank any cached editorial item.
      const score = Math.max(0, recency - 0.05);
      const record = {
        headline: item.headline,
        url: item.url,
        source: item.source,
        time: item.time,
        summary: '',
        articleType: null,
        provenance: null,
        sourceLabel: null,
        translate: null,
        tickers: new Set(tickers),
        companyNames: new Set(),
        score,
        cached: true,
        // Phase 2 tags
        mentionedEntities: item.mentionedEntities || [],
        topics: item.topics || [],
        sourceTier: item.sourceTier ?? null,
        articleShape: item.articleShape || 'news',
      };
      byUrl.set(item.url, record);
      if (headlineKey) byHeadline.set(headlineKey, record);
      cachedItemsMerged++;
    }
  }
  if (cachedItemsMerged > 0) {
    console.log(
      `[must-reads] live=${liveCount} cached-merged=${cachedItemsMerged} ` +
        `(snapshot ${CACHED_NEWS_SNAPSHOT.fetchedAt || 'unknown'})`
    );
  }

  // Materialise items once; we'll derive Must-Reads and Most-Recents pools
  // from this shared base. Two filters:
  //   - looksLikeJunkPage: drops stock-quote / metrics / profile pages
  //     that Google News indexes as articles. See _urlFilters.js.
  //   - Phase 4 hard age floor: drops items > 365 days. The audit found
  //     ~52% of the recent pool was older than a year, dragging stale
  //     items into the Home "All time" view. Items with no parseable
  //     time pass through (undated is better than silently dropped).
  const HARD_AGE_FLOOR_MS = 365 * 24 * 60 * 60 * 1000;
  const ageFloorCutoff = now - HARD_AGE_FLOOR_MS;
  const materialised = Array.from(byUrl.values())
    .filter((i) => {
      if (looksLikeJunkPage(i)) return false;
      if (!i.time) return true;
      const t = new Date(i.time).getTime();
      if (Number.isNaN(t)) return true;
      return t >= ageFloorCutoff;
    })
    .map((i) => ({
      ...i,
      tickers: Array.from(i.tickers),
      companyNames: Array.from(i.companyNames),
    }));

  // === Most-Recents pool ===
  // Dedup'd, time-sorted, RECENT_CAP cap. No per-entity rebalancing
  // here — the client handles that in Home.jsx filterRecent where it
  // has classifySource available and can pick the highest-tier items
  // per entity rather than the freshest. Items without a parseable
  // time are dropped (the chronological sort would bury them anyway).
  let recentCandidates = materialised
    .filter((it) => {
      if (!it.time) return false;
      const t = new Date(it.time).getTime();
      return !isNaN(t);
    })
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, RECENT_CAP);

  // === Must-Reads pool ===
  // Diversity cap + oversample top 20 by score.
  const byTicker = new Map();
  const untickered = [];
  for (const it of materialised) {
    const primary = it.tickers[0];
    if (!primary) {
      untickered.push(it);
      continue;
    }
    if (!byTicker.has(primary)) byTicker.set(primary, []);
    byTicker.get(primary).push(it);
  }
  const diverse = [...untickered];
  for (const items of byTicker.values()) {
    items.sort((a, b) => b.score - a.score);
    diverse.push(...items.slice(0, PER_TICKER_CAP));
  }
  let candidates = diverse
    .sort((a, b) => b.score - a.score)
    .slice(0, MUST_READS_CANDIDATE_CAP);

  // === Enrich Must-Reads candidates with Claude ===
  // Recent items aren't enriched here anymore — that pool is up to 500
  // items strong, far past what fits in a single Haiku call without
  // truncating the JSON response. Items that happen to overlap between
  // pools get enrichment for free via the URL map below. Most Recent's
  // opinion filter still works on Claude-classified items; pure-recent
  // items without classification just stay (the client's tier-4 and
  // blocked-source filters still apply).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && candidates.length > 0) {
    const enriched = await enrichWithClaude(candidates, apiKey);
    const enrichedByUrl = new Map(enriched.map((s) => [s.url, s]));
    const applyEnrich = (it) => {
      const e = enrichedByUrl.get(it.url);
      if (!e) return it;
      return {
        ...it,
        summary: e.summary || it.summary || '',
        articleType:
          it.articleType === 'press-release'
            ? 'press-release'
            : e.articleType || it.articleType,
        headline: e.headline || it.headline,
      };
    };
    candidates = candidates.map(applyEnrich);
    recentCandidates = recentCandidates.map(applyEnrich);
  }

  // === Must-Reads final filter — drop opinion, keep PRs, take top N ===
  let items = candidates
    .filter(
      (c) => c.articleType === 'press-release' || c.articleType !== 'opinion'
    )
    .slice(0, MUST_READS_OUTPUT_CAP);
  if (items.length < 4) {
    const opinionFill = candidates
      .filter((c) => c.articleType === 'opinion')
      .slice(0, MUST_READS_OUTPUT_CAP - items.length);
    items = [...items, ...opinionFill];
  }

  // === Most-Recents final filter — drop Claude-flagged opinion, keep PRs.
  // The tier-4-source filter (TipRanks/Motley Fool/etc.) is applied
  // client-side in Home.jsx, same as the existing Must-Reads belt-and-
  // suspenders, so we don't duplicate the source-classifier here.
  const recent = recentCandidates.filter(
    (c) => c.articleType === 'press-release' || c.articleType !== 'opinion'
  );

  // Strip internal fields before returning.
  const strip = ({ companyNames, translate, score, ...rest }) => rest;
  return res
    .setHeader(
      'Cache-Control',
      'public, s-maxage=1800, stale-while-revalidate=3600'
    )
    .status(200)
    .json({
      items: items.map(strip),
      recent: recent.map(strip),
      fetchedAt: new Date().toISOString(),
      queried: queries.length,
      upstreamErrors,
      prItemsTotal,
      // Failover-layer diagnostics — clients can show a "snapshot
      // ~N hrs ago" badge when cachedItemsMerged > 0.
      cachedItemsMerged,
      snapshotAt: CACHED_NEWS_SNAPSHOT.fetchedAt || null,
    });
}

// =====================================================================
// Per-query fetchers
// =====================================================================

async function fetchGoogleNewsForQuery({ q, ticker }) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      q
    )}&hl=en-US&gl=US&ceid=US:en`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BluOrNewsTracker/1.0)',
        Accept: 'application/rss+xml, application/xml',
      },
    });
    if (!r.ok) return { ticker, q, items: [], error: `Upstream ${r.status}` };
    const xml = await r.text();
    const items = parseGoogleNewsRss(xml).slice(0, GOOGLE_NEWS_PER_QUERY);
    return { ticker, q, items };
  } catch (e) {
    return { ticker, q, items: [], error: e.message };
  }
}

async function fetchOfficialForQuery({ q, ticker }) {
  if (!ticker) return { ticker: '', q, items: [] };
  try {
    const fetched = await fetchOfficialSources(ticker);
    return { ticker, q, items: fetched.items.slice(0, OFFICIAL_PER_QUERY) };
  } catch (e) {
    return { ticker, q, items: [], error: e.message };
  }
}

// =====================================================================
// Claude enrichment
// =====================================================================

async function enrichWithClaude(items, apiKey) {
  const hasTranslate = items.some((it) => it.translate);

  const translationInstruction = hasTranslate
    ? `

For any item marked "[TRANSLATE: pt-en]" below, translate the headline into clear English and write the summary in English. Preserve regulatory codes (e.g. "Fato Relevante") in parentheses.`
    : '';

  const prompt = `You are an analyst at BluOr Asset Management triaging portfolio news.

For each item below, do TWO things:

1. SUMMARY: 1-2 concise sentences describing what likely happened and why it might matter. Use your knowledge of the company to add context. Be neutral and factual.

2. CLASSIFY as one of:
   - "press-release" = official disclosure from the company itself OR a regulatory filing (8-K, 10-Q, 6-K, 40-F, DEF 14A, CVM "Fato Relevante", IR-page announcement). ALWAYS use this label if the item is marked "[PR · ...]" below — those are pre-confirmed official sources.
   - "news"   = factual third-party reporting of an event (transaction, earnings, regulatory action, deal, management change, market data).
   - "opinion" = analyst recommendation, "X reasons to buy/sell," contributor pump pieces, retail-investor takes, listicles, speculative or promotional content where the AUTHOR'S TAKE is the primary value.

When in doubt between news and opinion, call it "news". Reserve "opinion" for clearly promotional or take-driven pieces.${translationInstruction}

Return STRICT JSON only — no markdown, no preamble:
[{"url":"...","summary":"...","articleType":"press-release"|"news"|"opinion","headline":"..."}]

Headlines:
${items
  .map((it, i) => {
    const prTag =
      it.articleType === 'press-release'
        ? `[PR · ${it.provenance || 'official'}${it.sourceLabel ? ' · ' + it.sourceLabel : ''}] `
        : '';
    const xlTag = it.translate ? `[TRANSLATE: ${it.translate}] ` : '';
    return `${i + 1}. ${prTag}${xlTag}[${it.source}] About: ${it.companyNames.join(', ')}
   ${it.headline}
   URL: ${it.url}`;
  })
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
        // 100 candidates × ~80 output tokens/item = ~8000 tokens worst
        // case. Headroom on top so the JSON doesn't truncate mid-array.
        max_tokens: 10000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok)
      return items.map((it) => ({
        url: it.url,
        summary: '',
        articleType: it.articleType || null,
        headline: it.headline,
      }));
    const data = await r.json();
    const text = data?.content?.[0]?.text || '';
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed))
      return items.map((it) => ({
        url: it.url,
        summary: '',
        articleType: it.articleType || null,
        headline: it.headline,
      }));
    return parsed.map((p) => ({
      url: p.url,
      summary: typeof p.summary === 'string' ? p.summary : '',
      articleType:
        p.articleType === 'press-release'
          ? 'press-release'
          : p.articleType === 'opinion'
          ? 'opinion'
          : p.articleType === 'news'
          ? 'news'
          : null,
      headline: typeof p.headline === 'string' ? p.headline : '',
    }));
  } catch {
    return items.map((it) => ({
      url: it.url,
      summary: '',
      articleType: it.articleType || null,
      headline: it.headline,
    }));
  }
}

// =====================================================================
// Google News RSS parser
// =====================================================================

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

// Normalised key for headline-based dedupe. We're targeting the
// "same article, different wire/syndication" case — Google News
// returns the same story from Reuters AND Yahoo AND Bloomberg under
// different redirect URLs and slightly different titles (each adds
// " - <Publication>" at the end). Steps:
//   1. Drop the trailing " - <up-to-40-chars>" suffix Google News
//      appends. Catches both "- Bloomberg" and "- Bloomberg.com" and
//      "- Reuters India" without needing per-source matching.
//   2. Strip stopwords + punctuation, collapse whitespace.
//   3. Sort the significant words alphabetically so minor word-order
//      tweaks ("Apple Q1 earnings" vs "Q1 earnings Apple") still
//      hash to the same key.
//   4. Short keys (< 5 significant words) skip dedupe — too high a
//      false-positive rate on boilerplate ("Quarterly results"
//      shouldn't collapse every earnings article).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'and', 'or', 'but', 'from', 'by', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'has', 'have', 'had', 'will', 'would', 'this', 'that',
  'it', 'its', 's', 'said', 'says', 'after', 'before', 'over', 'up',
  'down', 'about',
]);
function normalizeHeadline(s) {
  if (!s || typeof s !== 'string') return '';
  // 1. Drop the trailing " - <suffix>" Google News appends.
  let cleaned = s.replace(/\s+[-–—]\s+[^-–—]{1,60}$/, '');
  cleaned = cleaned.toLowerCase();
  // 2. Strip non-alphanumeric to spaces.
  cleaned = cleaned
    .replace(/[''""]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 3. Stopword strip + sort significant words.
  const words = cleaned.split(' ').filter((w) => w && !STOPWORDS.has(w));
  if (words.length < 5) return '';
  return words.sort().join(' ');
}
