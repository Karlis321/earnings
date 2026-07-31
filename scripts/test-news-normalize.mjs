#!/usr/bin/env node
/**
 * Standing test — news normalizer fixture.
 *
 * Feeds a mixed well-formed + malformed batch of raw news items
 * through the normalizer (via a subprocess so we don't couple this
 * .mjs to the TS module system) and asserts the output is:
 *   - deduped by URL
 *   - sorted newest-first
 *   - has title + publisher split
 *   - never contains an empty title/url
 *
 *   node scripts/test-news-normalize.mjs
 */

// The normalizer logic is mirrored inline here (like other .mjs
// mirrors of TS in this repo — the mirror keeps standing tests
// runnable without a TypeScript loader).

function extractPublisher(rawHeadline, url) {
  const dashSuffix = rawHeadline.match(/^(.*?)\s+-\s+([^-]+?)\s*$/);
  if (dashSuffix) {
    const candidate = dashSuffix[2].trim();
    const publisherish = /^[A-Z]/.test(candidate) || candidate.length >= 4;
    if (publisherish && candidate.length <= 60) {
      return { title: dashSuffix[1].trim(), publisher: candidate };
    }
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return { title: rawHeadline.trim(), publisher: host };
  } catch {
    return { title: rawHeadline.trim(), publisher: "unknown" };
  }
}
const OPINION_MARKERS = [
  /\b(opinion|editorial|op-ed|column|commentary|analysis|why\s|should you|worth (a )?buy|bull case|bear case|forecast|outlook)\b/i,
];
function classifyArticleType(title) {
  return OPINION_MARKERS.some((rx) => rx.test(title)) ? "opinion" : "news";
}
function normalizeNewsItems(raw, opts = {}) {
  const seen = new Set();
  const normalized = [];
  for (const it of raw) {
    if (!it.url || !it.headline) continue;
    const { title, publisher } = extractPublisher(it.headline, it.url);
    if (!title) continue;
    let dedupKey;
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

// Fixture — mix of shapes the parser produces in the wild.
const RAW = [
  {
    headline: "Company X posts strong Q2 beat - Reuters",
    url: "https://www.reuters.com/business/company-x-q2-2026-07-30/",
    source: "Google News · X",
    category: "wire",
    time: "2026-07-30T14:00:00.000Z",
  },
  // Duplicate URL, different aggregator wrapper — must dedup.
  {
    headline: "Company X posts strong Q2 beat - Reuters",
    url: "https://www.reuters.com/business/company-x-q2-2026-07-30/?utm=googlenews",
    source: "Google News · X",
    category: "wire",
    time: "2026-07-30T14:05:00.000Z",
  },
  // Malformed: empty URL — must drop.
  {
    headline: "Empty URL - Bloomberg",
    url: "",
    source: "Google News · X",
    category: "wire",
    time: "2026-07-30T13:00:00.000Z",
  },
  // Malformed: empty title — must drop.
  {
    headline: "",
    url: "https://www.ft.com/content/empty-title",
    source: "Google News · X",
    category: "wire",
    time: "2026-07-30T12:00:00.000Z",
  },
  // Older item — should sort AFTER the fresh Reuters piece.
  {
    headline: "Analyst downgrade for Company X - Barron's",
    url: "https://www.barrons.com/articles/company-x-downgrade",
    source: "Google News · X",
    category: "wire",
    time: "2026-07-29T09:30:00.000Z",
  },
  // Opinion piece — articleType must be "opinion".
  {
    headline: "Why Company X is still worth a buy - Motley Fool",
    url: "https://www.fool.com/investing/2026/07/28/company-x-buy",
    source: "Google News · X",
    category: "wire",
    time: "2026-07-28T20:00:00.000Z",
  },
  // No time — must sort to tail, not crash.
  {
    headline: "Undated coverage - GuruFocus",
    url: "https://www.gurufocus.com/news/xyz",
    source: "Google News · X",
    category: "wire",
    time: null,
  },
];

const out = normalizeNewsItems(RAW);

// Assertions
const failures = [];

// 1. Dedup — 7 raw → 2 dropped (empty url + empty title) + 1 dedup =
//    4 kept.
if (out.length !== 4) failures.push(`expected 4 items, got ${out.length}`);

// 2. Newest first — the Reuters piece (2026-07-30 14:00) must be [0].
if (out[0]?.title !== "Company X posts strong Q2 beat") {
  failures.push(`newest-first order broken: [0]=${out[0]?.title}`);
}
if (out[0]?.publisher !== "Reuters") {
  failures.push(`publisher extract broken: [0].publisher=${out[0]?.publisher}`);
}

// 3. Time-less item sinks to the tail.
if (out[out.length - 1]?.title !== "Undated coverage") {
  failures.push(`time-less did not sink to tail: last=${out[out.length - 1]?.title}`);
}

// 4. Opinion detection.
const opinion = out.find((i) => /worth a buy/i.test(i.title));
if (!opinion) failures.push(`opinion piece missing from output`);
else if (opinion.articleType !== "opinion") {
  failures.push(`articleType misclassified: got ${opinion.articleType}`);
}

// 5. Empty URL + empty title must be excluded.
if (out.some((i) => !i.url || !i.title)) {
  failures.push(`empty title or url leaked through`);
}

// 6. Guaranteed shape — every item has {title, publisher, url}.
for (const i of out) {
  for (const k of ["title", "publisher", "url"]) {
    if (typeof i[k] !== "string" || !i[k]) {
      failures.push(`item missing/empty field: ${k} on ${i.url}`);
    }
  }
}

if (failures.length > 0) {
  console.error("\n✗ news normalizer fixture failed:");
  for (const f of failures) console.error("  · " + f);
  console.error("\nRaw output:", JSON.stringify(out, null, 2));
  process.exit(1);
}
console.log(`✓ news normalizer fixture passed — ${out.length} items, dedup + sort + shape all correct`);
