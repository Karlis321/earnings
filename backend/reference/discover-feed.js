// /api/discover-feed?url=<https://blog.example.com>
//
// Given any URL the analyst pastes, return either:
//   - an RSS / Atom feed URL  ({ kind: 'rss', feedUrl, source })
//   - a Google-News site-filter handle when no RSS exists, so the
//     curated-source flow can still pull content from sites like
//     wsj.com or ft.com ({ kind: 'site-filter', hostname })
//
// Discovery cascade
// =================
//  0. Substack profile URLs (`substack.com/@username`) resolve via a
//     dedicated path — we fetch the profile page and look for the
//     publication's own subdomain (`username.substack.com`). Notes-only
//     feed is the last resort.
//  1. If the URL itself looks like a feed (ends in /feed, /feed/, /rss,
//     /atom.xml, /index.xml, /rss.xml, or returns XML content-type),
//     use it as-is.
//  2. Fetch the URL as HTML. Look for
//       <link rel="alternate" type="application/rss+xml"  href="...">
//       <link rel="alternate" type="application/atom+xml" href="...">
//     This is the W3C-blessed autodiscovery mechanism and most platforms
//     emit it (Substack, Ghost, WordPress, Beehiiv, Medium publications).
//  3. Try common path conventions: /feed /feed/ /rss /rss.xml /atom.xml
//     /index.xml. First one that returns XML wins.
//  4. Site-filter fallback. If the page exists (or even if it didn't),
//     return a `site-filter` result keyed by the URL's hostname. The
//     curated-source pipeline polls Google News with
//     `<keywords> site:<hostname>` when it sees this kind — giving us
//     content from any major news site without needing their RSS.

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const FALLBACK_PATHS = [
  '/feed',
  '/feed/',
  '/rss',
  '/rss.xml',
  '/atom.xml',
  '/index.xml',
];

// Major news publishers whose homepage RSS feeds are full-firehose and
// indistinct (every section, every story) — useless for ticker- and
// theme-scoped curated polling. We route them straight to the site-
// filter path (Google News + `site:<host>`) regardless of whether
// RSS autodiscovery would have succeeded. Keeps the chip labelling
// consistent across publishers (NYT, WSJ, FT, Bloomberg, Reuters all
// read "Site search · <host>") and the actual results targeted to
// whichever holding / theme the source is scoped to.
const MAJOR_NEWS_HOSTS = new Set([
  'nytimes.com',
  'wsj.com',
  'ft.com',
  'bloomberg.com',
  'reuters.com',
  'washingtonpost.com',
  'cnbc.com',
  'forbes.com',
  'economist.com',
  'marketwatch.com',
  'barrons.com',
  'theguardian.com',
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'cnn.com',
  'nikkei.com',
  'scmp.com',
  'globeandmail.com',
  'thetimes.co.uk',
]);

export function isMajorNewsHost(host) {
  if (!host) return false;
  const lower = host.toLowerCase();
  if (MAJOR_NEWS_HOSTS.has(lower)) return true;
  for (const h of MAJOR_NEWS_HOSTS) {
    if (lower.endsWith(`.${h}`)) return true;
  }
  return false;
}

function looksLikeFeedPath(url) {
  const m = url.toLowerCase().match(/[^?#]*/);
  const path = m ? m[0] : url;
  return /(\/feed\/?|\/rss(\.xml)?|\/atom\.xml|\/index\.xml)$/.test(path);
}

function isXmlContentType(ct) {
  if (!ct) return false;
  const t = ct.toLowerCase();
  return t.includes('xml') || t.includes('rss') || t.includes('atom');
}

async function probe(url) {
  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
    return {
      ok: r.ok,
      status: r.status,
      contentType: r.headers.get('content-type') || '',
      finalUrl: r.url || url,
      response: r,
    };
  } catch (e) {
    return { ok: false, status: 0, contentType: '', finalUrl: url, error: e.message };
  }
}

function findAutodiscoverLink(html, baseUrl) {
  if (!html) return null;
  const linkRe = /<link\s[^>]*>/gi;
  let m;
  const candidates = [];
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!href) continue;
    if (!/\balternate\b/i.test(rel)) continue;
    if (!/(rss|atom)\+xml/i.test(type)) continue;
    candidates.push({ tag, type, href });
  }
  if (candidates.length === 0) return null;
  const rss = candidates.find((c) => /rss\+xml/i.test(c.type));
  const best = rss || candidates[0];
  try {
    return new URL(best.href, baseUrl).toString();
  } catch {
    return null;
  }
}

// Substack profile URLs (substack.com/@username) point at the user's
// profile on Substack's main domain, not at their publication. The
// publication lives at <username>.substack.com (usually) and that's
// where the article RSS feed is. We:
//   - fetch the profile HTML
//   - grep for any *.substack.com subdomain references (excluding the
//     bare username one as a fallback)
//   - probe the most likely candidate's /feed
// If everything fails we return Substack's notes feed for the user
// (substack.com/feed/@username) — at minimum the user's microblog
// posts will show.
async function resolveSubstackProfile(username) {
  const tried = [];
  const profileUrl = `https://substack.com/@${username}`;
  let html = '';
  try {
    const r = await fetch(profileUrl, { headers: BROWSER_HEADERS, redirect: 'follow' });
    if (r.ok) html = await r.text();
  } catch {}

  // Collect unique substack.com subdomains from the HTML.
  const subRe = /https?:\/\/([a-z0-9][a-z0-9-]*)\.substack\.com\b/gi;
  const candidates = new Set();
  if (html) {
    let m;
    while ((m = subRe.exec(html)) !== null) {
      const sub = m[1].toLowerCase();
      if (sub !== 'www' && sub !== 'on' && sub !== 'open') {
        candidates.add(sub);
      }
    }
  }
  // Always try the username-as-subdomain too — common Substack pattern.
  candidates.add(username.toLowerCase());

  // Probe each candidate's /feed; first XML response wins.
  for (const sub of candidates) {
    const feedUrl = `https://${sub}.substack.com/feed`;
    tried.push(feedUrl);
    const r = await probe(feedUrl);
    if (r.ok && isXmlContentType(r.contentType)) {
      return { feedUrl, source: 'substack-publication' };
    }
  }

  // Last resort: the profile's own notes feed. Always exists on
  // Substack even when the user has no publication.
  const notesFeed = `https://substack.com/feed/@${username}`;
  tried.push(notesFeed);
  const r = await probe(notesFeed);
  if (r.ok && isXmlContentType(r.contentType)) {
    return { feedUrl: notesFeed, source: 'substack-notes' };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!raw) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (u.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only https:// URLs are accepted' });
  }

  // Hardening: block private / loopback / link-local hosts.
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^(10|192\.168)\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    return res.status(400).json({ error: 'Private hosts not allowed' });
  }

  // (0b) Major news publisher host — skip RSS detection entirely.
  // NYT / WSJ / FT / Bloomberg / Reuters / etc. all publish full-
  // firehose RSS that's unfiltered by topic. Routing them through the
  // site-filter path (Google News + `site:<host>`) gives the analyst
  // ticker- and theme-scoped results plus a consistent chip label
  // across publishers (the previous mix where only NYT got "Newsletter"
  // and the rest got "Site search" was confusing).
  if (isMajorNewsHost(host)) {
    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    return res.status(200).json({
      kind: 'site-filter',
      hostname: host,
      displayUrl: u.toString(),
      note:
        `${host} routed via Google News + \`site:${host}\` so results are ` +
        `scoped to whichever holdings / themes you assign.`,
    });
  }

  // (0a) Twitter / X profile URL — handle separately so we land on the
  // TwitterAPI.io profile-tweet path rather than trying to find RSS on
  // x.com (which has none and rejects most reads anyway). Accepts the
  // public-facing forms: https://x.com/<handle>, https://twitter.com/<handle>,
  // and the optional /status/<id> tail (we strip back to the handle).
  // Sub-paths like /lists, /followers, /communities are rejected — they
  // aren't accounts.
  const twitterMatch = u.toString().match(
    /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[\/?#]|$)/i
  );
  if (twitterMatch) {
    const handle = twitterMatch[1];
    const reserved = new Set([
      'home', 'explore', 'notifications', 'messages', 'i', 'settings',
      'search', 'compose', 'login', 'signup', 'tos', 'privacy',
      'about', 'jobs', 'communities', 'lists',
    ]);
    if (!reserved.has(handle.toLowerCase())) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      return res.status(200).json({
        kind: 'twitter-account',
        handle,
        displayUrl: `https://x.com/${handle}`,
        note:
          `We'll poll @${handle}'s recent tweets and surface the ones ` +
          `that mention each holding / theme this source is scoped to.`,
      });
    }
  }

  // (0) Substack profile URL — handle separately so we land on the
  // publication's article feed instead of trying to discover RSS on
  // substack.com itself (which has none).
  const profileMatch = u.toString().match(/^https:\/\/(?:www\.)?substack\.com\/@([A-Za-z0-9_-]+)/i);
  if (profileMatch) {
    const resolved = await resolveSubstackProfile(profileMatch[1]);
    if (resolved) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      return res.status(200).json({ kind: 'rss', ...resolved });
    }
    // Couldn't find a Substack feed — fall through to site-filter
    // mode below.
  }

  // (1) If the URL itself looks like a feed path, accept it.
  if (looksLikeFeedPath(u.toString())) {
    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    return res.status(200).json({ kind: 'rss', feedUrl: u.toString(), source: 'as-is' });
  }

  // (2) Autodiscover via <link rel="alternate">.
  const head = await probe(u.toString());
  if (head.ok) {
    if (isXmlContentType(head.contentType)) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      return res.status(200).json({ kind: 'rss', feedUrl: head.finalUrl, source: 'as-is' });
    }
    try {
      const html = await head.response.text();
      const discovered = findAutodiscoverLink(html, head.finalUrl);
      if (discovered) {
        res.setHeader('Cache-Control', 'public, s-maxage=86400');
        return res.status(200).json({ kind: 'rss', feedUrl: discovered, source: 'autodiscover' });
      }
    } catch {
      // continue to fallback paths
    }
  }

  // (3) Path conventions.
  const base = `${u.protocol}//${u.host}`;
  for (const path of FALLBACK_PATHS) {
    const guess = base + path;
    const r = await probe(guess);
    if (r.ok && isXmlContentType(r.contentType)) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      return res.status(200).json({ kind: 'rss', feedUrl: r.finalUrl, source: 'fallback' });
    }
  }

  // (4) Site-filter fallback. The site doesn't expose RSS we can find,
  // but the analyst still wants content from it. Curated-source fetch
  // will query Google News with `<keywords> site:<hostname>` to surface
  // articles from this site under whichever stocks / themes it's
  // scoped to.
  res.setHeader('Cache-Control', 'public, s-maxage=86400');
  return res.status(200).json({
    kind: 'site-filter',
    hostname: host,
    displayUrl: u.toString(),
    note:
      "No RSS feed found. We'll search Google News for items from " +
      `${host} that match the targets you scope this source to.`,
  });
}
