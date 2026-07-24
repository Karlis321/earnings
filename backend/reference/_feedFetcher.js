// Shared fetcher for the per-holding official-feed registry.
//
// Returns normalized items WITHOUT Claude enrichment — that's the caller's job.
// Used by /api/press-releases (single-ticker fetch) and /api/must-reads
// (multi-ticker fan-out alongside Google News).

import { getOfficialSources, isWireSource } from './_officialSources.js';
import { stripCdata, stripHtml, extractTag } from './_html.js';

// SEC fair-access policy requires a User-Agent with a contact.
const SEC_UA = 'BluOr News Tracker klpp@bluorbank.lv';
// Q4-hosted IR feeds (centuryaluminum.com, hudbayminerals.com, etc.) and
// several other vendor IR platforms 403 anything that doesn't look like
// a real browser. Send a current Chrome UA + Accept-Language so we get
// served the same content a user clicking the link would. Verified that
// CENX 403→200 and HBM IR item URLs 403→200 just by swapping this.
const GENERIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const GENERIC_ACCEPT_LANG = 'en-US,en;q=0.9';

// EDGAR forms we consider "material" — the rest are noise (insider trades,
// ownership filings, agent appointments, late-filing notices).
export const EDGAR_MATERIAL_FORMS = new Set([
  '8-K', '8-K/A',
  '10-K', '10-K/A',
  '10-Q', '10-Q/A',
  '6-K', '6-K/A',
  '20-F', '20-F/A',
  '40-F', '40-F/A',
  'DEF 14A', 'PRE 14A',
  '425',
  'S-1', 'S-1/A', 'F-1', 'F-1/A',
  'S-3', 'S-3/A', 'F-3', 'F-3/A',
]);

export const EDGAR_FORM_LABELS = {
  '8-K':       'Material event filing',
  '8-K/A':     'Material event filing (amended)',
  '10-K':      'Annual report',
  '10-K/A':    'Annual report (amended)',
  '10-Q':      'Quarterly report',
  '10-Q/A':    'Quarterly report (amended)',
  '6-K':       'Foreign issuer current report',
  '6-K/A':     'Foreign issuer current report (amended)',
  '20-F':      'Foreign issuer annual report',
  '40-F':      'Canadian issuer annual report',
  'DEF 14A':   'Proxy statement',
  'PRE 14A':   'Preliminary proxy statement',
  '425':       'M&A communication',
};

// Pulls all configured feeds for a single Bloomberg ticker. Returns:
//   { items, sourcesPolled, upstreamErrors, hasSources, needsTranslation }
export async function fetchOfficialSources(bloombergTicker) {
  const sources = getOfficialSources(bloombergTicker);
  if (sources.length === 0) {
    return {
      items: [],
      sourcesPolled: 0,
      upstreamErrors: 0,
      hasSources: false,
      needsTranslation: false,
    };
  }

  const results = await Promise.all(sources.map(fetchSource));

  const byUrl = new Map();
  let upstreamErrors = 0;
  let needsTranslation = false;

  for (const r of results) {
    if (r.error) upstreamErrors++;
    for (const item of r.items) {
      if (item.translate) needsTranslation = true;
      const existing = byUrl.get(item.url);
      if (!existing) {
        byUrl.set(item.url, item);
        continue;
      }
      // Same URL from multiple feeds — prefer the more authoritative provenance.
      const rank = { regulatory: 3, 'ir-page': 2, wire: 1 };
      if ((rank[item.provenance] || 0) > (rank[existing.provenance] || 0)) {
        byUrl.set(item.url, item);
      }
    }
  }

  // Second-pass dedupe: same release often appears at both its source (e.g.
  // Newsfile / IR-page) AND via the Yahoo wire-aggregator, with different
  // URLs. Group by minute-precision timestamp + normalized headline prefix.
  // Within each group, keep the highest-authority copy.
  const byFuzzy = new Map();
  for (const it of byUrl.values()) {
    const key = fuzzyKey(it);
    if (!key) {
      // No usable timestamp — leave alone (avoid collapsing into a single group).
      byFuzzy.set(`__nokey_${Math.random()}`, it);
      continue;
    }
    const existing = byFuzzy.get(key);
    if (!existing || authorityRank(it) > authorityRank(existing)) {
      byFuzzy.set(key, it);
    }
  }

  const items = Array.from(byFuzzy.values()).sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : 0;
    const tb = b.time ? new Date(b.time).getTime() : 0;
    return tb - ta;
  });

  return {
    items,
    sourcesPolled: sources.length,
    upstreamErrors,
    hasSources: true,
    needsTranslation,
  };
}

function fuzzyKey(it) {
  if (!it.time) return null;
  const titleKey = (it.headline || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
  if (!titleKey) return null;
  // Minute precision: same press release sometimes shows ±a few seconds across
  // mirrors. ISO format YYYY-MM-DDTHH:MM is enough granularity.
  return `${it.time.slice(0, 16)}|${titleKey}`;
}

function authorityRank(it) {
  const provRank =
    { regulatory: 3, 'ir-page': 2, wire: 1 }[it.provenance] || 0;
  // Yahoo aggregator copies are tagged 'wire' but the direct Newsfile/wire
  // page is more authoritative than the Yahoo mirror, so deprioritize Yahoo.
  const isYahooMirror = it.url && /finance\.yahoo\.com/.test(it.url);
  return provRank * 10 - (isYahooMirror ? 1 : 0);
}

async function fetchSource(source) {
  try {
    let items;

    if (source.kind === 'mziq') {
      // Mziq is a POST-only JSON API; handled specially, then fall through
      // to the metadata-tagging code below.
      items = await fetchMziqDocuments(source);
    } else {
      const headers = {
        Accept:
          'application/atom+xml, application/rss+xml, application/xml;q=0.9, ' +
          'text/html;q=0.8, */*;q=0.5',
        'Accept-Language': GENERIC_ACCEPT_LANG,
        'User-Agent': source.kind === 'edgar' ? SEC_UA : GENERIC_UA,
      };
      const r = await fetch(source.url, { headers });
      if (!r.ok) return { source, items: [], error: `Upstream ${r.status}` };
      const xml = await r.text();

      if (source.kind === 'edgar') {
        items = parseEdgarAtom(xml)
          .filter((it) => EDGAR_MATERIAL_FORMS.has(it.formType))
          .map((it) => ({
            ...it,
            headline: EDGAR_FORM_LABELS[it.formType]
              ? `${EDGAR_FORM_LABELS[it.formType]} (${it.formType})`
              : `SEC filing (${it.formType})`,
          }));
      } else if (source.kind === 'html-abxx') {
        items = parseAbxxPressReleases(xml);
      } else if (source.kind === 'html-shle') {
        items = parseShlePressReleases(xml);
      } else {
        items = parseRss2(xml);
      // Drop non-English items (Newsfile cross-posts German/French translations
      // of the same release — keeping them creates apparent duplicates).
      items = items.filter((it) => !it.lang || /^en/i.test(it.lang));
      if (source.filterWires) {
        // Yahoo's per-ticker RSS embeds the originating wire (e.g.
        // "(GLOBE NEWSWIRE)", "ACCESS Newswire") in the description text — the
        // <source> element is usually absent and the link points to Yahoo's
        // own domain. So we also scan the description.
        items = items.filter(
          (it) =>
            isWireSource(it.source) ||
            isWireSource(it.url) ||
            isWireSource(it.summary)
        );
      }
      }
    }

    items = items.map((it) => ({
      ...it,
      // Per-source URL rewriter. Some feeds publish item links that don't
      // resolve on the publisher's own site (Topicus's RSS, for example,
      // omits the /news/ path and every link 404s). Letting the source
      // descriptor declare a `urlFix(url) -> url` keeps the workaround
      // narrow and explicit rather than scattering domain logic in the
      // parser.
      url: typeof source.urlFix === 'function' ? source.urlFix(it.url) : it.url,
      provenance: source.provenance,
      sourceLabel: source.label,
      source: source.kind === 'edgar' ? 'SEC EDGAR' : (it.source || source.label),
      translate: source.translate || null,
      articleType: 'press-release',
    }));

    return { source, items };
  } catch (e) {
    return { source, items: [], error: e.message };
  }
}

// =====================================================================
// EDGAR Atom parser
// =====================================================================

function parseEdgarAtom(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  // Allow attributes on <entry> (e.g. <entry xml:lang="en">) — some feeds
  // include them.
  const entryRegex = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const c = m[1];
    const title = stripCdata(extractTag(c, 'title'));
    const updated = stripCdata(extractTag(c, 'updated'));
    const published = stripCdata(extractTag(c, 'published'));
    const linkMatch = c.match(/<link[^>]*href="([^"]+)"[^>]*>/i);
    const link = linkMatch ? linkMatch[1] : '';
    const catMatch = c.match(/<category[^>]*term="([^"]+)"[^>]*>/i);
    const formType = catMatch ? catMatch[1].trim() : '';

    if (!title || !link) continue;
    const time = updated || published;
    const date = time ? new Date(time) : null;
    out.push({
      headline: title,
      url: link,
      source: 'SEC EDGAR',
      time: date && !isNaN(date.getTime()) ? date.toISOString() : null,
      formType,
      summary: '',
    });
  }
  return out;
}

// =====================================================================
// Generic RSS 2.0 parser
// =====================================================================

export function parseRss2(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  // Allow attributes on <item> (Newsfile uses <item xml:lang="en">).
  const itemRegex = /<item(?:\s([^>]*))?>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const c = m[2];
    const langMatch = attrs.match(/xml:lang="([^"]+)"/i);
    const lang = langMatch ? langMatch[1] : null;

    const title = stripCdata(extractTag(c, 'title'));
    let link = stripCdata(extractTag(c, 'link'));
    if (!link) {
      const altLink = c.match(/<link[^>]+href="([^"]+)"/i);
      if (altLink) link = altLink[1];
    }
    const pubDate =
      stripCdata(extractTag(c, 'pubDate')) ||
      stripCdata(extractTag(c, 'dc:date'));
    const description = stripCdata(extractTag(c, 'description'));
    // Substack/Beehiiv/Ghost ship the full post body in <content:encoded>.
    // Keep raw HTML stripped to plain text — independent-research matches
    // keywords against this so a passing mention of a holding in the body
    // surfaces the post even when the subtitle doesn't name it.
    const contentEncoded = stripCdata(extractTag(c, 'content:encoded'));
    const sourceMatch = c.match(/<source[^>]*>([^<]+)<\/source>/i);
    let source = sourceMatch ? sourceMatch[1].trim() : '';

    if (!source && link) {
      try {
        const u = new URL(link);
        source = u.hostname.replace(/^www\./, '');
      } catch {
        // ignore
      }
    }

    if (!title || !link) continue;
    const date = pubDate ? new Date(pubDate) : null;
    out.push({
      headline: title,
      url: link,
      source,
      time: date && !isNaN(date.getTime()) ? date.toISOString() : null,
      summary: stripHtml(description).slice(0, 500),
      // Full body (HTML-stripped, capped) — present only if the feed includes
      // <content:encoded>. Press-release callers ignore this; independent-
      // research uses it for keyword matching.
      content: contentEncoded ? stripHtml(contentEncoded).slice(0, 8000) : '',
      lang,
    });
  }
  return out;
}


// =====================================================================
// HTML parsers for sites that don't expose RSS/Atom.
//
// These extract press releases directly from the IR page DOM. Inherently
// more fragile than feeds — a site redesign will break them. Mitigate by
// failing gracefully (return []) so a broken parser just means the holding
// shows the existing "No official sources" UI banner.
// =====================================================================

// ABXX (Abaxx Technologies) — investors.abaxx.tech is a Next.js app. The
// press-release list ships as a JSON array inside React Server Component
// chunks of the page HTML: self.__next_f.push([1, "...pressReleases:[{...}]..."])
// We concatenate the chunks, JSON-unescape them, and pull out the array.
function parseAbxxPressReleases(html) {
  if (!html) return [];
  const chunkRegex = /self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\.)*)"\]\)/g;
  let combined = '';
  let m;
  while ((m = chunkRegex.exec(html)) !== null) {
    // Each chunk's payload is a JSON string literal — wrap+parse to unescape.
    try {
      combined += JSON.parse('"' + m[1] + '"');
    } catch {
      combined += m[1];
    }
  }
  const arrMatch = combined.match(/"pressReleases"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  if (!arrMatch) return [];
  let arr;
  try {
    arr = JSON.parse(arrMatch[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p) => p && p.title && p.slug)
    .map((p) => {
      // publish_date is YYYY-MM-DD; treat as noon UTC so day-of-publication is preserved across timezones.
      const date = p.publish_date ? new Date(p.publish_date + 'T12:00:00Z') : null;
      return {
        headline: p.title,
        url: `https://investors.abaxx.tech/press-releases/${p.slug}`,
        source: 'investors.abaxx.tech',
        time: date && !isNaN(date.getTime()) ? date.toISOString() : null,
        summary: p.excerpt || '',
      };
    });
}

// BOLSY (B3 SA) — IR page hosted on Mziq's WordPress + JSON-API platform.
// The site loads filings client-side from apicatalog.mziq.com/filemanager with
// a POST call carrying { categoryInternalNames, language, published }.
// No auth token required despite the misleading 401 on naive GETs — the API
// just requires POST + a known CORS origin.
//
// Document schema (per item):
//   { id, company_id, file_title, file_url, file_published_date,
//     category_internal_name, language_code, permalink, ... }
//
// We ask for language=en_US (B3 publishes English translations for material
// facts, which is the bulk of what we want). Falls back to PT if EN is empty.
async function fetchMziqDocuments(source) {
  const url = `https://apicatalog.mziq.com/filemanager/company/${source.fmId}/filter/categories/meta`;
  const headers = {
    'Content-Type': 'application/json',
    Origin: source.origin || 'https://ri.b3.com.br',
    Referer: source.referer || 'https://ri.b3.com.br/en/regulatory-filings/',
    'User-Agent': GENERIC_UA,
  };
  const body = JSON.stringify({
    categoryInternalNames: source.categories,
    language: source.language || 'en_US',
    published: true,
  });
  const r = await fetch(url, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`Mziq HTTP ${r.status}`);
  const data = await r.json();
  if (!data || data.success !== true) return [];
  const metas = (data.data && data.data.document_metas) || [];
  return metas
    .filter((m) => m && (m.file_title || m.file_name_original))
    .map((m) => {
      const date = m.file_published_date ? new Date(m.file_published_date) : null;
      return {
        headline: (m.file_title || m.file_name_original).trim(),
        url: m.permalink || m.file_url,
        source: 'ri.b3.com.br',
        time: date && !isNaN(date.getTime()) ? date.toISOString() : null,
        summary: '',
      };
    });
}

// SHLE (Source Energy Services) — webflow-hosted IR page with each release
// in a repeating div block. Pattern (whitespace-normalized):
//   <div class="news-release__date-field">May 8, 2026</div>
//   <a href="/news-releases/<slug>" class="home-news__link ...">
//     <h5 class="mt-0">Title</h5>
//   </a>
//   <p class="news-release__excerpt">Excerpt...</p>
function parseShlePressReleases(html) {
  if (!html) return [];
  const itemRegex =
    /<div class="news-release__date-field">\s*([^<]+?)\s*<\/div>[\s\S]*?<a[^>]+href="(\/news-releases\/[^"]+)"[^>]*>[\s\S]*?<h5[^>]*>\s*([^<]+?)\s*<\/h5>[\s\S]*?<\/a>(?:[\s\S]*?<p class="news-release__excerpt">\s*([^<]*?)\s*<\/p>)?/g;
  const items = [];
  let m;
  while ((m = itemRegex.exec(html)) !== null) {
    const dateStr = m[1];
    const slug = m[2];
    const title = m[3];
    const excerpt = m[4] || '';
    // Date format on SHLE is "May 8, 2026" — JS Date parses that natively.
    const date = new Date(dateStr + ' UTC');
    items.push({
      headline: title.trim(),
      url: 'https://www.sourceenergyservices.com' + slug,
      source: 'sourceenergyservices.com',
      time: !isNaN(date.getTime()) ? date.toISOString() : null,
      summary: excerpt.trim(),
    });
  }
  return items;
}
