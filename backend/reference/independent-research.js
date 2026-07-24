// /api/independent-research?ticker=BN+US
//
// Pulls posts from the curated registry of independent newsletters
// (Substack/Beehiiv/Ghost/blog) defined in `_independentSources.js`, filters
// them to the ones whose title or description mentions the holding via its
// per-ticker keyword list, and (if ANTHROPIC_API_KEY is set) asks Claude
// Haiku for a 1-2 sentence relevance-aware summary.
//
// Response shape mirrors /api/press-releases so the CompanyDetail view can
// merge the three feeds (news + press releases + independent) by URL.

import { PUBLICATIONS, getKeywordsForTicker, matchesAnyKeyword } from './_independentSources.js';
import { parseRss2 } from './_feedFetcher.js';
import { isLikelyArticleUrl, looksLikeJunkPage } from './_urlFilters.js';
import { verifyArticleUrls } from './_articleVerifier.js';
import { mentionsHolding } from './_tickerMatch.js';
import { stripCdata, decodeHtmlEntities } from './_html.js';
import { getSectorTags } from './_entityRegistry.js';
import { tagItem } from './_itemTagger.js';

const GENERIC_UA = 'Mozilla/5.0 (compatible; BluOrNewsTracker/1.0)';

// Per-publication cap before keyword filtering — protects against one
// high-volume publication crowding out the rest. Bumped 120 → 300 to
// give each Substack / site-filter source more material to filter from.
const PER_PUB_RAW_CAP = 300;

// Final per-ticker cap for BUILT-IN publications (Doomberg, MBI Deep
// Dives, etc.). User-added curated sources are NOT capped here — the
// analyst added them explicitly, they want everything that matches.
// Bumped 100 → 400 for fatter historical depth on "All time".
const BUILTIN_PER_TICKER_CAP = 400;

// Hard upper bound on the response. Raised 500 → 2000 to match the
// raised per-pub / per-ticker caps.
const HARD_RESPONSE_CAP = 2000;

// Cap on user-supplied custom feeds polled per request. 100 → 200 — at
// 200 a single per-ticker fetch is ~3-4 s on warm cache, well inside
// Vercel's 60 s function timeout.
const MAX_CUSTOM_SOURCES = 200;

// Phase 9 — name-anchored gate for THEME queries.
//
// The endpoint's legacy keyword filter (matchesAnyKeyword) admits an
// item if ANY supplied keyword appears in the body. For theme
// queries, where the keyword set includes broad terms like "oil",
// "brent", "credit losses", this admits every Substack article that
// mentions one of those words — so Mining.com pieces about Australian
// gold and Doomberg "Party Pooper" essays surface on the Strait of
// Hormuz page. The fix is to require the THEME NAME to anchor the
// match. Keywords / countries become supporting signals.
//
// Match classes (mirror src/themeTaxonomy.js isItemRelevantToTheme):
//   STRONG — literal theme name OR all sigs distributed in haystack
//   PARTIAL — most sigs + at least one supporting keyword
//   else — drop
//
// `themeName` is conventionally passed as keywords[0] by the client
// (CompanyDetail constructs `[themeEntity.name, ...pills]`). For
// per-stock tickers this is the company name, but those tickers
// take the legacy `matchesAnyKeyword` path because the keyword set
// IS the entity's name alias list and the result of name OR alias
// match IS the intended admission criterion.
const THEME_STOPWORDS = new Set([
  'the','and','or','of','for','in','on','at','to','a','an','&','with','from',
  'is','are','was','were','be','as','by',
]);

function themeNameSigs(name) {
  if (!name || typeof name !== 'string') return [];
  const cleaned = name
    .toLowerCase()
    .replace(/[''`]s\b/g, '')
    .replace(/s[''`]\b/g, 's')
    .replace(/[^a-z0-9\s]+/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !THEME_STOPWORDS.has(w));
}

function themeRelevantMatch(hay, themeName, supportingKeywords) {
  if (!themeName) return false;
  const lowerHay = hay.toLowerCase();
  const lowerName = themeName.toLowerCase().trim();
  // STRONG: literal name in haystack
  if (lowerName && lowerHay.includes(lowerName)) return true;
  const sigs = themeNameSigs(themeName);
  if (sigs.length === 0) {
    return supportingKeywords.some((k) => lowerHay.includes(k.toLowerCase()));
  }
  const sigsMatched = sigs.filter((w) => lowerHay.includes(w)).length;
  // STRONG: all sigs distributed in haystack
  if (sigsMatched === sigs.length) return true;
  // Single-word names: literal-only — already checked above.
  if (sigs.length === 1) return false;
  // PARTIAL: (n-1) sigs for 3+ word names, 1 sig for 2-word names,
  // PLUS at least one supporting keyword match.
  const sigsRequired = sigs.length >= 3 ? sigs.length - 1 : 1;
  if (sigsMatched < sigsRequired) return false;
  return supportingKeywords.some((k) => k && lowerHay.includes(k.toLowerCase()));
}

// Phase 8 — topic-overlap fallback. When an item's title / body /
// slug doesn't contain any per-ticker keyword (the legacy matcher
// misses it), but the ITEM's own derived topics (from the Phase 2
// tagger's headline content scan) overlap with the entity's
// `sectorTags` from the canonical registry, the item is admitted via
// the topical path.
//
// Critical design point: the overlap check uses the ITEM's topics, not
// the publication's curated coverage area. Mining.com is topic-tagged
// `['mining', 'copper', 'gold', ...]` because that's WHAT IT COVERS,
// but a Mining.com article about hydrogen partnerships in
// Newfoundland is not actually about copper, even though it ships
// from a copper-tagged publication. The Phase 2 tagger scans the
// headline against the entity-sectorTag universe and produces
// per-article topics — those are the ones we intersect with. This is
// the structural fix for the audit's #1 complaint ("12 of 15 stocks
// return ≤2 indep items") AND prevents the inverse failure
// (publication-overlap admitting unrelated articles from a sector-
// relevant publisher).
//
// Per-publication cap keeps a high-cadence source like Mining.com
// (5+ articles/day) from flooding a single ticker's page. Name-matches
// (legacy path) are uncapped — those are confirmed-relevant by name.
const TOPIC_OVERLAP_PER_PUB_CAP = 15;

// Three tiers of topic specificity for the Phase 8 admission gate:
//
//   GENERIC — never count toward overlap. Too broad to discriminate
//     any entity. 'macro' would match every BN article on macro
//     news, 'commodities' would match every Mining.com / HFI piece
//     for every commodities holding. These are filtered out before
//     intersection.
//
//   BROAD — count toward overlap BUT require co-occurrence with at
//     least one non-broad specific topic. The audit failure case:
//     "Peru election too close to call" from Mining.com surfaces on
//     Capstone Copper because the item-tagger detected 'mining'
//     from the headline and CS CN has 'mining' in sectorTags. The
//     intersection is non-empty but contains ONLY a broad sector
//     descriptor. To admit, the item also needs a specific topic
//     match (copper, gold, chile, etc.) — which Peru-election doesn't
//     have.
//
//   SPECIFIC — count toward overlap, admit standalone. These are
//     entity-discriminating topics that genuinely narrow the field
//     ('copper', 'gold', 'oil-gas', 'real-estate', country/sector
//     jurisdictions etc.).
const GENERIC_TOPICS = new Set([
  'macro',
  'equities',
  'commodities',
  'financials',
  // 'small-caps' is structural metadata, not a sector.
  'small-caps',
  // analyst-style tags that publications self-apply but don't refine
  // sector relevance
  'value',
  'special-situations',
  'investing',
  // 'tech' alone is too broad; specific software/saas/vms tags carry it
  'tech',
]);

const BROAD_TOPICS = new Set([
  // 'mining' covers gold / copper / lithium / hydrogen / silver / etc.
  // — too broad to discriminate among copper miners, gold miners, etc.
  'mining',
  // 'canada' is a jurisdiction; for a Canadian-listed copper miner, a
  // Canada-mining article that doesn't mention copper isn't material.
  // Pair with a specific topic to admit.
  'canada',
]);

// Specific (non-generic) topic intersection. Empty array → no overlap.
// BROAD topics ARE included in the intersection result — the
// downstream admission rule decides whether broad-only overlap admits.
function specificTopicIntersection(pubTopics, entitySectorTags) {
  if (!Array.isArray(pubTopics) || !Array.isArray(entitySectorTags)) return [];
  const pub = new Set(
    pubTopics
      .map((t) => String(t || '').toLowerCase().trim())
      .filter((t) => t && !GENERIC_TOPICS.has(t))
  );
  const ent = new Set(
    entitySectorTags
      .map((t) => String(t || '').toLowerCase().trim())
      .filter((t) => t && !GENERIC_TOPICS.has(t))
  );
  const out = [];
  for (const t of pub) if (ent.has(t)) out.push(t);
  return out;
}

// True if the overlap contains at least one non-broad specific topic.
// Used at the admission point to require a discriminating tag —
// 'mining' alone doesn't qualify; 'mining' + 'copper' does.
function hasDiscriminatingOverlap(overlap) {
  return Array.isArray(overlap) && overlap.some((t) => !BROAD_TOPICS.has(t));
}

const PLATFORM_WHITELIST = new Set([
  'substack', 'beehiiv', 'ghost', 'medium', 'blog', 'trade-press', 'twitter',
  'twitter-account', 'site',
]);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker : '';
  if (!ticker) {
    return res.status(400).json({ error: 'Missing ticker parameter' });
  }

  // The Themes flow calls this endpoint with ticker = `theme-<uuid>` and
  // its own keyword list via `q`. The built-in TICKER_KEYWORDS lookup
  // has no entry for themes, so we fall back to the override list there.
  // Built-in PUBLICATIONS (Doomberg, MBI Deep Dives, Felder Report,
  // Northern Miner, etc.) are polled for BOTH stocks AND themes — the
  // per-publication keyword filter on title/summary/content body decides
  // which items surface. Earlier this endpoint skipped builtins entirely
  // for themes; that wiped out ~18 Substacks worth of editorial depth
  // from every theme page.
  const rawQ = typeof req.query.q === 'string' ? req.query.q : '';
  const overrideKeywords = rawQ
    ? rawQ.split(',').map((k) => k.trim()).filter(Boolean)
    : null;
  // Merge the override (theme keywords / stock display.name) with the
  // hand-curated TICKER_KEYWORDS aliases (Bruce Flatt, BAM, Hat copper-
  // gold, etc.). Themes have no TICKER_KEYWORDS entry; their keywords
  // come solely from the override. Stocks combine both so site-filter
  // sources fire AND the alias list still picks up paraphrases.
  const tickerKeywords = getKeywordsForTicker(ticker);
  const keywords = Array.from(
    new Set([...(overrideKeywords || []), ...tickerKeywords].map((s) => String(s || '').trim()).filter(Boolean))
  );

  const customSources = parseCustomSources(req.query.custom);

  // If neither the builtin keywords nor any custom source exist, there's
  // nothing meaningful to return. Custom sources without keywords still get
  // fetched — the user gets every item from those feeds (no keyword filter)
  // so they can sanity-check the integration before adding keywords.
  if (keywords.length === 0 && customSources.length === 0) {
    return res.status(200).json({
      ticker,
      count: 0,
      items: [],
      fetchedAt: new Date().toISOString(),
      coverage: 'none',
      message: 'No independent-research keywords configured for this ticker',
    });
  }

  const builtIns = PUBLICATIONS;
  const allPublications = [...builtIns, ...customSources];
  const fetched = await Promise.all(
    allPublications.map((p) => fetchPublication(p, keywords, ticker))
  );

  // Phase 8 — compute entity sectorTags once for the topic-overlap
  // fallback. Empty for theme tickers and for unknown watchlist
  // entries (the registry returns []). When empty, the fallback is
  // skipped and only legacy keyword matches admit items, preserving
  // the prior behavior for those callers.
  const isStockTicker =
    typeof ticker === 'string' &&
    !ticker.startsWith('theme-') &&
    !ticker.startsWith('lookup-');
  const isTheme = typeof ticker === 'string' && ticker.startsWith('theme-');
  const entitySectorTags = isStockTicker ? getSectorTags(ticker) : [];

  // Per-publication count of items admitted via the topic-overlap
  // fallback. Keeps a high-cadence source like Mining.com from
  // flooding a single page with its entire daily output (it publishes
  // 5-10 mining/copper items a day; per-pub cap = 20 keeps coverage
  // useful without drowning out specific-name matches).
  const topicMatchesByPub = new Map();
  let nameMatches = 0;
  let topicMatches = 0;

  let upstreamErrors = 0;
  const byUrl = new Map();
  for (const r of fetched) {
    if (r.error) upstreamErrors++;
    for (const item of r.items) {
      // Two acceptance paths for built-in publications (site-filter +
      // twitter-account sources pre-set preFiltered=true and skip
      // both):
      //
      //   1. NAME PATH (legacy). Keyword match in title / summary /
      //      content body / normalized URL slug. Slug is critical for
      //      paywalled sites (WSJ, Bloomberg) and for Substacks where
      //      the article slug names the topic verbatim while the RSS
      //      title paraphrases.
      //
      //   2. TOPIC PATH (Phase 8). Publication's curated `topics`
      //      overlap with the entity's `sectorTags` in at least one
      //      specific (non-generic) sector tag. Capped per publication
      //      so a high-volume trade-press source doesn't crowd out
      //      name-matches.
      //
      // The mark on the item — matchVia: 'name' | 'topic' — lets the
      // Curated panel show topical reading as a separate row from
      // direct name matches.
      let matchVia = null;
      if (item.preFiltered) {
        matchVia = item.isCustom ? 'custom' : 'name';
      } else if (keywords.length > 0) {
        const urlSlugWords = (item.url || '')
          .toLowerCase()
          .replace(/^https?:\/\/[^/]+/, '')
          .replace(/[-_/.?=&]/g, ' ');
        // FULL haystack — title + summary + content + slug. Used by
        // per-stock matching where keywords ARE the entity's alias
        // list (Capstone Copper, Mantoverde, etc.); long content
        // bodies are an asset there because they catch paraphrased
        // mentions that the title alone misses.
        const hay = `${item.headline}\n${item.summary || ''}\n${item.content || ''}\n${urlSlugWords}`;
        // TIGHT haystack — title + summary + slug only. Used by theme
        // matching, where the keyword set is broad (e.g., "oil",
        // "brent") and the content body leaks through. Mining.com's
        // RSS content:encoded for an Australian gold article often
        // contains cross-references to other mining stories
        // including Hormuz oil pieces in their footers; matching the
        // theme NAME against the full body admits every such article
        // even though it's not actually about the theme. The tight
        // haystack restricts theme matching to what the article is
        // primarily about (headline + lede summary + URL slug).
        const tightHay = `${item.headline}\n${item.summary || ''}\n${urlSlugWords}`;
        // Phase 9: theme queries get the name-anchored gate. The
        // client passes the theme name as keywords[0] and pills
        // afterwards; a Substack item must EITHER include the theme
        // name (strong) OR include enough sig words + a supporting
        // keyword. This stops broad keywords like "oil" from
        // admitting every Mining.com piece on a Hormuz feed.
        //
        // Per-stock tickers keep the legacy keyword OR-match against
        // the FULL body: their keywords ARE the entity's alias list,
        // and a body-level mention of "Capstone Copper" IS a
        // legitimate match.
        if (isTheme) {
          const themeName = keywords[0] || '';
          const supportingKeywords = keywords.slice(1);
          if (themeRelevantMatch(tightHay, themeName, supportingKeywords)) {
            matchVia = 'name';
          }
        } else if (matchesAnyKeyword(hay, keywords)) {
          matchVia = 'name';
        }
      }
      // Topic-overlap fallback — only fires for stock tickers (themes
      // and lookups don't have sectorTags) and only when name-path
      // didn't already admit the item. Uses the ITEM's per-article
      // topics (tagger headline scan), NOT the publication's curated
      // coverage area, so a hydrogen article on Mining.com doesn't
      // surface on every copper holding just because Mining.com is
      // tagged `mining`. The headline has to actually mention a
      // sector-relevant term.
      //
      // Secondary requirement: the publication's coverage must ALSO
      // overlap with the entity's sectors. This stops a generic
      // macro publication from surfacing copper-incidental headlines
      // on copper holdings (defensive guard against the tagger
      // overshooting on a 5-word RSS title).
      if (
        !matchVia &&
        entitySectorTags.length > 0 &&
        Array.isArray(item.publicationTopics) &&
        item.publicationTopics.length > 0
      ) {
        const pubOverlap = specificTopicIntersection(
          item.publicationTopics,
          entitySectorTags
        );
        if (pubOverlap.length > 0) {
          // Run the tagger to extract per-article topics from the
          // headline + summary. Cheap (~50 regex tests) — done only
          // for items that don't already have a name match.
          const tagged = tagItem({
            headline: item.headline,
            summary: item.summary || '',
            source: item.source,
          });
          const itemOverlap = specificTopicIntersection(
            tagged.topics || [],
            entitySectorTags
          );
          // BROAD-topic guard: an item that only matches via 'mining'
          // alone (or 'canada' alone) isn't discriminating enough to
          // admit on a per-entity page. Require at least one
          // non-broad specific topic in the overlap. This stops
          // Mining.com's "Peru election too close to call" piece
          // from surfacing on every copper miner just because it's
          // tagged 'mining'.
          if (itemOverlap.length > 0 && hasDiscriminatingOverlap(itemOverlap)) {
            const pubId = item.publication || 'unknown';
            const cnt = topicMatchesByPub.get(pubId) || 0;
            if (cnt < TOPIC_OVERLAP_PER_PUB_CAP) {
              topicMatchesByPub.set(pubId, cnt + 1);
              matchVia = 'topic';
              // Annotate the matched tags so the UI can show
              // "Mining.com (copper / mining)" rather than just
              // "Mining.com". Useful when the user is asking "why is
              // this surfacing?".
              item.matchedTopics = itemOverlap;
            }
          }
        }
      }
      if (!matchVia) continue;

      const existing = byUrl.get(item.url);
      if (!existing) {
        if (matchVia === 'name') nameMatches++;
        else if (matchVia === 'topic') topicMatches++;
        // Drop internal-only fields. KEEP `isCustom` so the client can
        // distinguish built-in independent-research publications (Lawrence
        // Lepard, Doomberg, etc.) from user-added curated sources — the
        // "matches from curated sources" strip on CompanyDetail should
        // only show the latter. KEEP `matchVia` + `matchedTopics` so
        // the UI can group / annotate topical-reading rows.
        const { content, preFiltered, publicationTopics, ...rest } = item;
        byUrl.set(item.url, { ...rest, matchVia });
      }
    }
  }

  // Cap built-in items per ticker (high-volume publications shouldn't
  // dominate the page) but leave the user's own curated-source items
  // uncapped — the analyst added them explicitly, they want everything
  // that matches. Hard upper bound prevents a runaway analyst config
  // from breaking the Claude enrichment prompt.
  const allItems = Array.from(byUrl.values())
    // Belt-and-braces non-article filter — the verifier already rejects
    // quote/profile/metrics URLs for site-filter sources, but
    // looksLikeJunkPage also catches RSS items from non-site-filter
    // built-ins (e.g. a Substack auto-posting a ticker-only update).
    .filter((it) => !looksLikeJunkPage(it))
    .sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    });
  const builtin = allItems.filter((it) => !it.isCustom).slice(0, BUILTIN_PER_TICKER_CAP);
  const custom = allItems.filter((it) => it.isCustom);
  let items = [...builtin, ...custom]
    .sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    })
    .slice(0, HARD_RESPONSE_CAP);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && items.length > 0) {
    const enriched = await enrichWithClaude(items, ticker, apiKey);
    const byEnrichUrl = new Map(enriched.map((s) => [s.url, s]));
    items = items.map((it) => {
      const e = byEnrichUrl.get(it.url);
      if (!e) return it;
      return {
        ...it,
        summary: e.summary || it.summary || '',
        // If Claude says the item isn't really about this holding, drop it.
        // We still return the item (rather than filter) so the caller can
        // tell the difference between "no items matched" and "matched but
        // off-topic". The UI hides items where `offTopic === true`.
        offTopic: e.offTopic === true,
      };
    });
    items = items.filter((it) => !it.offTopic);
  }

  res.setHeader(
    'Cache-Control',
    'public, s-maxage=600, stale-while-revalidate=3600'
  );

  return res.status(200).json({
    ticker,
    count: items.length,
    items,
    fetchedAt: new Date().toISOString(),
    publicationsPolled: allPublications.length,
    customSourcesPolled: customSources.length,
    upstreamErrors,
    coverage: keywords.length === 0 ? 'custom-only' : 'configured',
    // Phase 8 — match-path attribution. nameMatches is the legacy
    // count (entity literally named in the post); topicMatches is the
    // new topical-reading count (publication topic ∩ entity sectorTags).
    // The Curated panel reads these to display a separate "topical
    // reading" row when topicMatches > 0.
    nameMatches,
    topicMatches,
  });
}

// Dispatcher — picks the right fetcher based on the publication's kind.
// Built-in publications + RSS-kind custom sources go through the RSS
// path; site-filter custom sources go through the Google News path;
// twitter-account custom sources go through TwitterAPI.io's last_tweets
// endpoint (filtered by keyword-mention so we only surface tweets that
// reference the scope ticker / theme).
async function fetchPublication(pub, keywords, ticker) {
  if (pub && pub.kind === 'site-filter') {
    return fetchSiteFilter(pub, keywords);
  }
  if (pub && pub.kind === 'twitter-account') {
    return fetchTwitterAccount(pub, keywords, ticker);
  }
  return fetchRssPublication(pub);
}

async function fetchRssPublication(pub) {
  try {
    const r = await fetch(pub.url, {
      headers: {
        Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
        'User-Agent': GENERIC_UA,
      },
    });
    if (!r.ok) return { publication: pub, items: [], error: `Upstream ${r.status}` };
    const xml = await r.text();
    const parsed = parseRss2(xml).slice(0, PER_PUB_RAW_CAP);
    const items = parsed.map((it) => ({
      ...it,
      source: pub.name,
      publication: pub.id,
      platform: pub.platform,
      articleType: 'independent',
      isCustom: pub.isCustom === true,
      // Phase 8: carry the publication's curated topics through so the
      // dedup filter can compare them against the entity's sectorTags.
      publicationTopics: Array.isArray(pub.topics) ? pub.topics : [],
    }));
    return { publication: pub, items };
  } catch (e) {
    return { publication: pub, items: [], error: e.message };
  }
}

// Site-filter fetcher — for curated sources where the user pasted a
// non-RSS site (e.g. wsj.com). We query Google News with the source's
// hostname constraint plus the holding/theme's keyword set. Items
// surface under the source's display name so the rest of the pipeline
// treats them as if they came from a regular feed.
//
// Article verification
// ====================
// Google News RSS returns its own redirect URLs
// (`news.google.com/rss/articles/<opaque>`) — a path-based filter on
// those URLs is useless, every URL has the same shape. The fix is the
// article verifier (api/_articleVerifier.js): for each candidate item
// it fetches the URL, follows redirects to land on the publisher URL,
// and checks BOTH a per-host article-path allowlist AND og:type /
// JSON-LD article-schema metadata. Items fail-out unless they're
// confirmed articles; survivors get their URL rewritten to the
// resolved publisher URL so clicks bypass the Google News interstitial.
//
// Headline keyword guard remains as a cheap pre-filter — drops items
// whose headline doesn't even contain the user's keywords (Google
// News' relevance match is too loose when the publisher is
// keyword-stuffed in page templates).
async function fetchSiteFilter(pub, keywords) {
  if (!pub.hostname) return { publication: pub, items: [] };
  if (!Array.isArray(keywords) || keywords.length === 0) {
    // Without keywords we'd pull every story from the host — too noisy.
    // Themes always supply keywords; per-ticker holdings have keyword
    // lookups in _independentSources. Either way, an empty list means
    // we should skip site-filter sources rather than flood the page.
    return { publication: pub, items: [] };
  }
  const phrase = (s) => `"${String(s).replace(/"/g, '')}"`;
  const q = `(${keywords.map(phrase).join(' OR ')}) site:${pub.hostname}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': GENERIC_UA,
        Accept: 'application/rss+xml, application/xml',
      },
    });
    if (!r.ok) return { publication: pub, items: [], error: `Google News ${r.status}` };
    const xml = await r.text();
    const lowerKw = keywords.map((k) => String(k || '').toLowerCase());

    // Pre-filter: headline-keyword guard. Cheaper than the verifier
    // and drops the obvious noise before we spend HTTP calls on it.
    const candidates = parseGoogleNewsRss(xml)
      .filter((it) => {
        const hay = ((it.headline || '') + ' ' + (it.summary || '')).toLowerCase();
        return lowerKw.some((k) => k && hay.includes(k));
      })
      .slice(0, PER_PUB_RAW_CAP);

    // Verify each surviving candidate by fetching + checking
    // og:type / JSON-LD + per-host article-path allowlist on the
    // resolved publisher URL. Concurrency-capped inside the verifier
    // so we don't fan-out unbounded.
    const verifications = await verifyArticleUrls(candidates.map((it) => it.url));

    const items = [];
    for (let i = 0; i < candidates.length; i++) {
      const v = verifications[i];
      if (!v || !v.ok) continue;
      const it = candidates[i];
      items.push({
        ...it,
        // Substitute the resolved publisher URL so a click goes
        // direct to wsj.com / bloomberg.com / etc. instead of
        // through news.google.com.
        url: v.finalUrl || it.url,
        source: pub.name,
        publication: pub.id,
        platform: pub.platform || 'site',
        articleType: 'independent',
        isCustom: true,
        // Keyword match + article verification both ran above. Skip
        // the downstream keyword filter to avoid double-counting.
        preFiltered: true,
      });
    }
    return { publication: pub, items };
  } catch (e) {
    return { publication: pub, items: [], error: e.message };
  }
}

// Twitter-account fetcher — for curated sources where the user pasted
// an X profile URL (e.g. https://x.com/HannesArt). Pulls the account's
// recent tweets via TwitterAPI.io's last_tweets endpoint, then filters
// to tweets that mention the scope ticker / theme keywords using the
// shared mentionsHolding matcher (recognises the company name + any
// alias + $TICKER cashtag + TICKER.TO/V/NE/CN Canadian suffix forms).
//
// Theme scope: instead of a ticker we have a free-form keyword list.
// The matcher falls back to substring keyword check when no ticker is
// supplied (theme flow).
//
// Requires TWITTERAPI_IO_KEY env var. Returns [] when unset (so a Twitter
// curated source still appears in the UI but renders as a no-content
// section). The user can add the key in Vercel project settings to
// activate.
async function fetchTwitterAccount(pub, keywords, ticker) {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey || !pub.handle) return { publication: pub, items: [] };
  try {
    const r = await fetch(
      `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(pub.handle)}`,
      { headers: { 'x-api-key': apiKey, Accept: 'application/json' } }
    );
    if (!r.ok) return { publication: pub, items: [], error: `TwitterAPI.io ${r.status}` };
    const data = await r.json();
    const tweets = Array.isArray(data?.data?.tweets) ? data.data.tweets : [];

    // Effective ticker for the fuzzy match — undefined when called from
    // a theme (no per-ticker context); the keyword list takes over.
    const effectiveTicker =
      typeof ticker === 'string' && !ticker.startsWith('theme-') && !ticker.startsWith('lookup-')
        ? ticker
        : '';

    const filtered = tweets.filter((t) => {
      const text = t?.text || '';
      if (effectiveTicker) {
        // Stock scope: full fuzzy match (name + cashtag + suffix forms +
        // user-supplied extras).
        return mentionsHolding(text, effectiveTicker, { extraAliases: keywords });
      }
      // Theme scope (or no ticker context): substring match against
      // the supplied keyword list. Keep the bar low — themes need
      // breadth, the relevance gate on the page tightens it later.
      if (!Array.isArray(keywords) || keywords.length === 0) return false;
      const lower = text.toLowerCase();
      return keywords.some(
        (k) => typeof k === 'string' && k.trim().length >= 3 && lower.includes(k.toLowerCase())
      );
    });

    const items = filtered.slice(0, PER_PUB_RAW_CAP).map((t) => {
      const handle = t.author?.userName || pub.handle;
      const text = (t.text || '').replace(/\s+/g, ' ').trim();
      const id = t.id;
      const url =
        t.twitterUrl ||
        t.url ||
        (handle && id ? `https://x.com/${handle}/status/${id}` : '');
      return {
        headline: text.length > 280 ? text.slice(0, 277) + '...' : text,
        url,
        time: t.createdAt ? safeIsoDate(t.createdAt) : null,
        summary: '',
        content: text,
        source: pub.name,
        publication: pub.id,
        platform: 'twitter',
        articleType: 'tweet',
        isCustom: true,
        handle,
        kind: 'status',
        // Already filtered via mentionsHolding / keyword substring —
        // skip the downstream keyword filter to avoid double-counting.
        preFiltered: true,
      };
    });

    return { publication: pub, items };
  } catch (e) {
    return { publication: pub, items: [], error: e.message };
  }
}

function safeIsoDate(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Minimal Google News RSS parser — extracts title, link, source, pubDate.
// Mirrors parseGoogleNewsRss in /api/must-reads.js (duplicated to keep
// this endpoint self-contained).
function parseGoogleNewsRss(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const c = m[1];
    const titleMatch = c.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = c.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const pubMatch = c.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const sourceMatch = c.match(/<source[^>]*>([^<]+)<\/source>/i);
    const title = stripCdata(titleMatch ? titleMatch[1] : '');
    const link = stripCdata(linkMatch ? linkMatch[1] : '');
    const pub = stripCdata(pubMatch ? pubMatch[1] : '');
    if (!title || !link) continue;
    const d = pub ? new Date(pub) : null;
    out.push({
      headline: title.length > 280 ? title.slice(0, 277) + '…' : title,
      url: link,
      summary: '',
      content: '',
      time: d && !isNaN(d.getTime()) ? d.toISOString() : null,
      sourceLabel: sourceMatch ? decodeHtmlEntities(sourceMatch[1].trim()) : '',
    });
  }
  return out;
}

// =====================================================================
// Custom-source decoding + URL validation
// =====================================================================

// Decodes the `custom` query param (base64-encoded JSON) into a sanitized
// list of publication descriptors. Untrusted client input — every URL is
// SSRF-checked, and the platform tag is constrained to a whitelist.
function parseCustomSources(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let json;
  try {
    json = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return [];
  }
  let arr;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof s.name === 'string' &&
        // Three valid shapes:
        //   - RSS feed (has a URL passing the SSRF guard)
        //   - Site filter (has a hostname)
        //   - Twitter account (has a syntactically-valid handle)
        ((typeof s.url === 'string' && isAllowedUrl(s.url)) ||
          (s.kind === 'site-filter' && typeof s.hostname === 'string') ||
          (s.kind === 'twitter-account' && typeof s.handle === 'string'))
    )
    .slice(0, MAX_CUSTOM_SOURCES)
    .map((s, i) => {
      const isSiteFilter = s.kind === 'site-filter';
      const isTwitterAccount = s.kind === 'twitter-account';
      return {
        id: `custom-${i}`,
        name: s.name.slice(0, 80),
        url: typeof s.url === 'string' ? s.url : '',
        platform: PLATFORM_WHITELIST.has(s.platform)
          ? s.platform
          : isTwitterAccount
          ? 'twitter'
          : isSiteFilter
          ? 'site'
          : 'blog',
        kind: isSiteFilter
          ? 'site-filter'
          : isTwitterAccount
          ? 'twitter-account'
          : 'rss',
        hostname:
          isSiteFilter && typeof s.hostname === 'string'
            ? sanitizeHostname(s.hostname)
            : null,
        handle:
          isTwitterAccount && typeof s.handle === 'string'
            ? sanitizeTwitterHandle(s.handle)
            : null,
        topics: ['custom'],
        isCustom: true,
      };
    })
    .filter((s) => {
      if (s.kind === 'site-filter') return !!s.hostname;
      if (s.kind === 'twitter-account') return !!s.handle;
      return true;
    });
}

// X / Twitter handle sanitiser. Accepts the bare username form
// (BluOrInsight) or the @-prefixed form (@BluOrInsight). Rejects
// anything that isn't a valid X handle (1-15 chars, alphanumeric +
// underscore — the constraint X itself enforces).
function sanitizeTwitterHandle(raw) {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
  return h;
}

// Hostname sanitiser for the site-filter mode. Strips protocol / path
// noise and rejects anything that doesn't look like a public DNS host.
function sanitizeHostname(raw) {
  const h = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('?')[0];
  if (!h) return null;
  if (!/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(h)) return null;
  if (h === 'localhost' || h.endsWith('.local')) return null;
  return h;
}

// SSRF guard: only allow https:// URLs to non-private hostnames. Same set of
// checks every server-side fetch of untrusted input needs — blocks localhost,
// RFC 1918 IPv4 ranges, link-local, and the common IPv6 private prefixes.
function isAllowedUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '0.0.0.0') return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (host === '::1') return false;
  if (/^fc/i.test(host) || /^fd/i.test(host) || /^fe80:/i.test(host)) return false;
  // Block the AWS/GCP metadata endpoints explicitly even though they're
  // already covered by the 169.254 link-local rule — defense in depth.
  if (host === 'metadata.google.internal') return false;
  return true;
}

async function enrichWithClaude(items, ticker, apiKey) {
  const prompt = `You are an analyst at BluOr Asset Management. Each item below is a post from an independent newsletter (Substack/blog). They were keyword-matched to ticker ${ticker} on the post title or excerpt — some matches will be substantive, others will be a passing mention or false positive.

For EACH item, do TWO things:

1. SUMMARY: 1-2 concise sentences describing what the post argues or reports, focused on the part relevant to ${ticker}. If the holding is only briefly mentioned, say so. Neutral and factual.

2. OFF-TOPIC flag: set "offTopic": true ONLY if the post does NOT meaningfully discuss the holding (e.g. the keyword match was incidental — a different company with a similar name, a one-word mention in a list). Set "offTopic": false if the post discusses the holding directly OR if it discusses an industry/theme where the holding is a primary example. When in doubt, set false.

Return STRICT JSON only — no markdown fences, no preamble:
[{"url":"...","summary":"...","offTopic":true|false}]

Items:
${items
  .map(
    (it, i) =>
      `${i + 1}. [${it.source}] ${it.headline}
   Excerpt: ${(it.summary || '').slice(0, 300)}
   URL: ${it.url}`
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
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return items.map((it) => ({ url: it.url, summary: '', offTopic: false }));
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
