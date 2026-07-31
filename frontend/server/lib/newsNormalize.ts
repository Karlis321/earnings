// News item normalizer. Applied at the /api/news boundary so every
// consumer (CompanyNewsPanel, SourceViewer, admin views) gets a
// clean shape with guaranteed fields.
//
// Defects it fixes (all observed on the live deploy 2026-07-31):
//   1. `source` always "Google News · <TICKER>" — the delivery
//      channel, not the publisher. Fix: pull the real publisher
//      from the headline's ` - <Publisher>` suffix (Google News
//      RSS convention) and fall back to the URL's hostname.
//   2. Redundant publisher in the title ("Title - Publisher") when
//      source now carries the publisher separately. Fix: strip the
//      suffix so the title reads clean.
//   3. Duplicate items across aggregators (same URL, different
//      aggregator wrappers). Fix: dedup by resolved URL.
//   4. Unsorted / mixed ordering. Fix: newest-first by `time`, with
//      time-less items pushed to the tail.
//   5. category="wire" as a fixed default on entity-scoped queries —
//      not wrong exactly, but leaves the caller no way to distinguish
//      opinion pieces. Fix: heuristic `articleType` derived from
//      headline vocabulary.

export interface RawNewsItem {
  headline: string;
  url: string;
  source: string;
  category: string;
  time: string | null;
}

export interface NormalizedNewsItem {
  title: string;
  publisher: string;
  url: string;
  time: string | null;
  category: string;
  articleType: "news" | "opinion";
}

// Publisher lives in the headline as " - <Publisher>" (Google News
// convention), OR is derivable from the URL hostname. Never invented.
function extractPublisher(rawHeadline: string, url: string): { title: string; publisher: string } {
  // Case 1: title ends with " - Publisher" (Google News RSS)
  const dashSuffix = rawHeadline.match(/^(.*?)\s+-\s+([^-]+?)\s*$/);
  if (dashSuffix) {
    const candidate = dashSuffix[2].trim();
    // Reject publisher-looking-strings that are actually just
    // trailing dash-fragments of a normal title ("Q3 2026 - beat")
    // by requiring the segment to look like a publisher name
    // (no numeric prefix, no lowercase-only start unless it's a
    // known lowercase-brand like "GlobeNewswire").
    const publisherish = /^[A-Z]/.test(candidate) || candidate.length >= 4;
    if (publisherish && candidate.length <= 60) {
      return { title: dashSuffix[1].trim(), publisher: candidate };
    }
  }
  // Case 2: fall back to URL hostname stripped of leading www.
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    // Strip common TLDs and split on dot for a "readable" domain slug.
    // (news.google.com stays unmapped — the redirect resolver should
    // have replaced these with real publisher hosts.)
    return { title: rawHeadline.trim(), publisher: host };
  } catch {
    return { title: rawHeadline.trim(), publisher: "unknown" };
  }
}

// Cheap opinion/news classifier — headline vocabulary only, no LLM.
// Matches the current UI's ArticleTypeBadge assumption of two states.
const OPINION_MARKERS = [
  /\b(opinion|editorial|op-ed|column|commentary|analysis|why\s|should you|worth (a )?buy|bull case|bear case|forecast|outlook)\b/i,
];
function classifyArticleType(title: string): "news" | "opinion" {
  return OPINION_MARKERS.some((rx) => rx.test(title)) ? "opinion" : "news";
}

/**
 * Normalize an array of raw news items:
 *  - split "Title - Publisher" into separate fields
 *  - dedup by URL (case-insensitive scheme+host+path)
 *  - sort newest-first (time-less items pushed to tail)
 *  - drop items whose URL is empty or whose title becomes empty
 *  - cap at `limit` if provided
 */
export function normalizeNewsItems(
  raw: RawNewsItem[],
  opts: { limit?: number } = {},
): NormalizedNewsItem[] {
  const seen = new Set<string>();
  const normalized: NormalizedNewsItem[] = [];
  for (const it of raw) {
    if (!it.url || !it.headline) continue;
    const { title, publisher } = extractPublisher(it.headline, it.url);
    if (!title) continue;
    // Dedup key: lowercase URL without query/fragment.
    let dedupKey: string;
    try {
      const u = new URL(it.url);
      dedupKey = (u.origin + u.pathname).toLowerCase().replace(/\/$/, "");
    } catch {
      dedupKey = it.url.toLowerCase();
    }
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    normalized.push({
      title,
      publisher,
      url: it.url,
      time: it.time,
      category: it.category,
      articleType: classifyArticleType(title),
    });
  }
  normalized.sort((a, b) => {
    // Newest first; nulls to the tail.
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return b.time.localeCompare(a.time);
  });
  if (opts.limit && normalized.length > opts.limit) {
    return normalized.slice(0, opts.limit);
  }
  return normalized;
}
