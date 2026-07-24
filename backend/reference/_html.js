// Shared HTML / RSS text utilities.
//
// Until this file existed, six API endpoints each shipped their own
// partial entity decoder — most only handled `&amp;`, `&lt;`, `&gt;`,
// `&quot;`, and a couple of numeric forms (`&#39;`). Numeric entities
// like `&#8217;` (right single quote) or `&#x2019;` (hex form of the
// same) survived intact and rendered literally on the page
// ("India&#8217;s energy security…"). Routing every RSS / HTML parse
// through `decodeHtmlEntities` here eliminates the class of bug.
//
// Decoding order (matters):
//   1. Numeric hex   `&#xHHHH;`
//   2. Numeric decimal `&#NNNN;`
//   3. Named entities
// Named entities go LAST so something like `&amp;#39;` (escaped form
// of the literal text "&#39;") decodes to `&#39;` rather than `'`.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // A handful of typographic entities that show up in publisher feeds.
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

function safeCodePoint(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '';
  // Disallow surrogate halves — they're not valid as standalone code points.
  if (cp >= 0xd800 && cp <= 0xdfff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

export function decodeHtmlEntities(s) {
  if (typeof s !== 'string' || s.length === 0) return s == null ? '' : String(s || '');
  return s
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : match
    );
}

// Strip CDATA wrapper THEN decode entities. Use on RSS title / link /
// pubDate / source — anywhere the publisher's raw text lands in an
// XML element.
export function stripCdata(s) {
  if (!s) return '';
  return decodeHtmlEntities(
    String(s).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
  ).trim();
}

// Strip HTML tags THEN decode entities THEN collapse whitespace.
// Use on RSS description / content:encoded — fields that ship a
// snippet of HTML markup.
export function stripHtml(s) {
  if (!s) return '';
  return decodeHtmlEntities(
    String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  ).trim();
}

// Extract the inner content of <tag>...</tag>. The local copies of this
// function in news.js / must-reads.js / _feedFetcher.js / etc. were
// identical — share one implementation so a future fix lands in one
// place.
export function extractTag(content, tag) {
  if (!content) return '';
  const m = content.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}
