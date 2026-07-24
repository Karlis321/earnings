// Tweet quality filter + engagement-weighted ranking.
//
// Applied to every tweet that enters the pool — from TwitterAPI.io's
// advanced_search, last_tweets, FinTwit fan-out, Bluesky, manual paste,
// the browser extension, and the historical data/tweets.json snapshot.
//
// Drops by `isQualityTweet`:
//   1. Length < 50 chars after URL / @mention / emoji strip. Cuts the
//      one-liner / cashtag-only / pure-pump posts that pollute the feed.
//   2. 0 likes AND 0 retweets AND > 2h old. Fresh tweets (≤ 2h) skip
//      the engagement floor — engagement hasn't accumulated yet, and
//      we don't want to hide breaking content.
//   3. Author is the holding's own X handle. Per user request: the
//      company's IR / marketing posts are not what the analyst wants
//      from the X feed; third-party commentary is the signal.
//
// Ranking via `tweetScore`:
//   score = log10(likes + 2*retweets + 1) * recencyWeight
//   recencyWeight: 1.00 (< 2h), 0.85 (< 24h), 0.60 (< 7d), 0.30 (< 30d), 0.10 (older)
//   Retweets weigh 2x because they signal more conviction than a passive like.

const MIN_TEXT_LEN = 50;
const ENGAGEMENT_FLOOR_AGE_HOURS = 2;

// Phase 7 hard time floor for tweets. Tweets older than this are
// dropped regardless of engagement or relevance signal. Tweets are
// even more time-sensitive than news — a high-engagement 2024 tweet
// about HOYA's cyber incident is no longer market-relevant in 2026,
// but its 5k likes would float it to the top under engagement-weighted
// ranking. 180 days is the tightest floor that still covers multi-
// month earnings arcs and policy debates.
export const TWEET_AGE_FLOOR_DAYS = 180;

// Phase 7 cashtag-stuffing detector. Spam-list tweets — the kind that
// pump signal bots produce — concatenate 4-8 cashtags with minimal
// surrounding prose ("$KAIA $CENX $BTC $ETH 🚀 telegram free signals").
// A bare $CENX matches mentionsHolding's cashtag rule, so without
// this structural filter every signal-list dragging Century into a
// crypto pump tweet would surface on the CENX page. Threshold tuned
// against the 2026-06-08 audit's CENX feed: legitimate analyst tweets
// average 1 cashtag with 12+ surrounding words; spam-list tweets
// average 4+ cashtags with <8 surrounding words.
const CASHTAG_STUFFED_MIN_COUNT = 3;
const CASHTAG_STUFFED_MAX_WORDS = 12;

// Phase 7 known spam-bot templates. Pattern-matched, not name-matched
// — these substrings appear in the spam-bot prose template, not in
// the cashtags themselves. Conservative list to avoid false positives
// on legitimate alert tweets that happen to use "🚨" or "free".
const SPAM_TEMPLATE_PATTERNS = [
  /jake\s+signals/i,
  /signal[s]?\s*\(\s*free\s*\)/i,
  /\btelegram\s*:/i,
  /\btelegram\.me\//i,
  /\bt\.me\//i,
  /follow\s+(?:me|us)\s+(?:on\s+)?(?:telegram|t\.me)/i,
  // Crypto pump-list tells:
  /\b(?:pump|moon|10x|100x)(?:ing|s)?\b/i,
  /\b(?:not\s+financial\s+advice|nfa)\b/i,
];

const URL_RE = /https?:\/\/\S+/gi;
const MENTION_RE = /@\w+/g;
const CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9.]{0,9}\b/g;
// Pictographic + symbol unicode ranges. Strips most emoji + decorative
// symbols. Conservative — won't catch every codepoint but covers the
// common rocket / fire / chart-up emoji that dominate pump posts.
const PICTOGRAPH_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;

function strippedTextLength(text) {
  if (!text || typeof text !== 'string') return 0;
  return text
    .replace(URL_RE, '')
    .replace(MENTION_RE, '')
    .replace(PICTOGRAPH_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

function engagementSum(item) {
  const e = item && item.engagement;
  if (!e) return 0;
  return (e.likes || 0) + (e.retweets || 0);
}

function ageHours(item, nowMs) {
  if (!item || !item.time) return Number.POSITIVE_INFINITY;
  const t = new Date(item.time).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (nowMs - t) / 3600000;
}

// True if the tweet survives all quality filters.
// `opts.companyHandle` (optional) — the holding's own X handle to drop.
// `opts.now` (optional) — override for the current ms timestamp (test hook).
export function isQualityTweet(item, opts = {}) {
  if (!item || !item.headline) return false;

  const text = item.headline;
  if (strippedTextLength(text) < MIN_TEXT_LEN) return false;

  const companyHandle =
    typeof opts.companyHandle === 'string' && opts.companyHandle
      ? opts.companyHandle.toLowerCase()
      : null;
  if (
    companyHandle &&
    typeof item.handle === 'string' &&
    item.handle.toLowerCase() === companyHandle
  ) {
    return false;
  }

  const nowMs = opts.now || Date.now();
  const age = ageHours(item, nowMs);
  if (age > ENGAGEMENT_FLOOR_AGE_HOURS && engagementSum(item) === 0) {
    return false;
  }

  return true;
}

// Engagement-weighted score for ranking. Higher is better.
// Pure-recency fallback when engagement metrics are absent (snapshot
// items, manual paste, extension content) — score = recencyWeight.
export function tweetScore(item, nowMs) {
  if (!item) return 0;
  const w = recencyWeight(ageHours(item, nowMs || Date.now()));
  const e = item.engagement;
  if (!e) return w;
  const eng = (e.likes || 0) + 2 * (e.retweets || 0);
  return Math.log10(eng + 1) * w + w * 0.01;
  // +w*0.01 keeps zero-engagement items ranked by recency rather than
  // collapsing them all to score 0.
}

function recencyWeight(age) {
  if (age < 2) return 1.0;
  if (age < 24) return 0.85;
  if (age < 24 * 7) return 0.6;
  if (age < 24 * 30) return 0.3;
  return 0.1;
}

// =====================================================================
// Phase 7 structural quality additions
// =====================================================================

// Distinct cashtags in the tweet text. `$BTC $btc` counts as one.
export function countDistinctCashtags(text) {
  if (!text || typeof text !== 'string') return 0;
  const tags = text.match(CASHTAG_RE) || [];
  const set = new Set(tags.map((t) => t.toUpperCase()));
  return set.size;
}

// Word count after stripping URLs, @-mentions, cashtags, and emoji.
// Used by the cashtag-stuffing detector — if the tweet is 80% cashtags
// and 20% prose, the cashtag count is the actual content and the
// "prose" is filler.
function proseWordCount(text) {
  if (!text || typeof text !== 'string') return 0;
  const stripped = text
    .replace(URL_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(CASHTAG_RE, ' ')
    .replace(PICTOGRAPH_RE, ' ')
    .replace(/[#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return 0;
  return stripped.split(/\s+/).length;
}

// True if the tweet is structurally a cashtag spam list — many
// cashtags relative to surrounding prose. The user blocking each
// junk source one-by-one is fine for new-attack mitigation, but the
// underlying PATTERN (cashtag list) can be detected without manual
// curation.
export function isCashtagStuffed(text) {
  const tags = countDistinctCashtags(text);
  if (tags < CASHTAG_STUFFED_MIN_COUNT) return false;
  const words = proseWordCount(text);
  // Either: many cashtags with very little prose (signal list)
  // Or: cashtags outnumber prose words (extreme list)
  if (words <= CASHTAG_STUFFED_MAX_WORDS) return true;
  if (tags >= 5 && tags >= words * 0.3) return true;
  return false;
}

// True if the tweet matches a known spam-bot template. Combined with
// isCashtagStuffed, this catches both the "structural" and "templated"
// halves of crypto signal spam — most spam tweets hit BOTH detectors
// so either one is sufficient to drop.
export function matchesSpamTemplate(text) {
  if (!text || typeof text !== 'string') return false;
  return SPAM_TEMPLATE_PATTERNS.some((re) => re.test(text));
}

// Compound spam check used at the tweet ingest gate. Either a
// cashtag-stuffed list OR a spam-template match drops the item.
// Note: legitimate financial bots (newsfile_corp, NorthernMiner)
// occasionally use 🚨-prefixed alerts but they DON'T cashtag-stuff
// or use telegram/jake-signals language, so neither detector fires.
export function isLikelySpamTweet(text) {
  return isCashtagStuffed(text) || matchesSpamTemplate(text);
}

// True if the tweet is older than the hard time floor. Tweets past
// the floor never reach the feed regardless of engagement.
export function isPastTimeFloor(item, nowMs) {
  if (!item || !item.time) return false; // undated → keep (rare)
  const t = new Date(item.time).getTime();
  if (!Number.isFinite(t)) return false;
  const ageDays = ((nowMs || Date.now()) - t) / (1000 * 60 * 60 * 24);
  return ageDays > TWEET_AGE_FLOOR_DAYS;
}

// Returns true if the tweet contains any of the entity's exclusion
// aliases — known collisions like "Hoya Capital" (for HOYA), "De La
// Hoya" (boxer), or Portuguese slang. The aliases come from the
// canonical entity registry (Phase 0). Empty list → pass through.
export function matchesExclusionAlias(text, exclusionAliases) {
  if (!text || typeof text !== 'string') return false;
  if (!Array.isArray(exclusionAliases) || exclusionAliases.length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  return exclusionAliases.some((a) => {
    if (!a || typeof a !== 'string') return false;
    return lower.includes(a.toLowerCase());
  });
}

// Entity-mention check that REJECTS cashtag-only matches inside a
// stuffed list. mentionsHolding will happily match `$CENX` in
// "$KAIA $CENX $BTC pump" because the regex sees the cashtag. This
// wrapper layers a content check on top: if the tweet is cashtag-
// stuffed AND the entity is ONLY referenced via its cashtag (no
// alias / name in the prose), reject.
//
// Returns true if the entity is mentioned meaningfully — name
// substring, cashtag with surrounding prose, or in a non-stuffed
// tweet.
export function isMeaningfulMention(text, ticker, mentionsHoldingFn, options = {}) {
  if (!text || !ticker) return false;
  // Defer to mentionsHolding for the basic check. If it returns
  // false, the tweet doesn't reference the entity at all.
  const hits = mentionsHoldingFn(text, ticker, options);
  if (!hits) return false;
  // If the tweet isn't cashtag-stuffed, the standard mention is
  // meaningful.
  if (!isCashtagStuffed(text)) return true;
  // Cashtag-stuffed: require the entity's NAME or one of its longer
  // aliases (length >= 5) to appear in the prose. If only the bare
  // cashtag is present, this is a list inclusion, not a mention.
  const aliases = Array.isArray(options.extraAliases) ? options.extraAliases : [];
  const all = [options.name, ...aliases]
    .filter((a) => a && typeof a === 'string' && a.length >= 5)
    .map((a) => a.toLowerCase());
  if (all.length === 0) return false;
  const lower = text.toLowerCase();
  return all.some((a) => lower.includes(a));
}
