import { NextRequest, NextResponse } from "next/server";
import type { DiscoverFeedResult } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST /api/discover-feed — classify a pasted URL as one of:
//   rss / substack / twitter / site-filter / rejected.
// Ported from backend/reference/discover-feed.js — the reference doc has the
// full rationale (major-news short-circuit, RSS autodiscover, substack
// profile resolution). We flatten the reference's per-kind shape into the
// FE's `DiscoverFeedResult` { kind, url, title?, note? }.

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FALLBACK_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/atom.xml", "/index.xml"];

const MAJOR_NEWS_HOSTS = new Set([
  "nytimes.com",
  "wsj.com",
  "ft.com",
  "bloomberg.com",
  "reuters.com",
  "washingtonpost.com",
  "cnbc.com",
  "forbes.com",
  "economist.com",
  "marketwatch.com",
  "barrons.com",
  "theguardian.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "cnn.com",
  "nikkei.com",
  "scmp.com",
  "globeandmail.com",
  "thetimes.co.uk",
]);

const TWITTER_RESERVED = new Set([
  "home", "explore", "notifications", "messages", "i", "settings",
  "search", "compose", "login", "signup", "tos", "privacy",
  "about", "jobs", "communities", "lists",
]);

function isMajorNewsHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (MAJOR_NEWS_HOSTS.has(lower)) return true;
  for (const h of MAJOR_NEWS_HOSTS) {
    if (lower.endsWith(`.${h}`)) return true;
  }
  return false;
}

function looksLikeFeedPath(url: string): boolean {
  const m = url.toLowerCase().match(/[^?#]*/);
  const path = m ? m[0] : url;
  return /(\/feed\/?|\/rss(\.xml)?|\/atom\.xml|\/index\.xml)$/.test(path);
}

function isXmlContentType(ct: string | null): boolean {
  if (!ct) return false;
  const t = ct.toLowerCase();
  return t.includes("xml") || t.includes("rss") || t.includes("atom");
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^(10|192\.168)\./.test(h) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)
  );
}

interface Probe {
  ok: boolean;
  status: number;
  contentType: string;
  finalUrl: string;
  response: Response | null;
}

async function probe(url: string): Promise<Probe> {
  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    return {
      ok: r.ok,
      status: r.status,
      contentType: r.headers.get("content-type") ?? "",
      finalUrl: r.url || url,
      response: r,
    };
  } catch {
    return { ok: false, status: 0, contentType: "", finalUrl: url, response: null };
  }
}

function findAutodiscoverLink(html: string, baseUrl: string): string | null {
  const linkRe = /<link\s[^>]*>/gi;
  const candidates: { type: string; href: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] ?? "";
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] ?? "";
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1] ?? "";
    if (!href) continue;
    if (!/\balternate\b/i.test(rel)) continue;
    if (!/(rss|atom)\+xml/i.test(type)) continue;
    candidates.push({ type, href });
  }
  if (candidates.length === 0) return null;
  const rss = candidates.find((c) => /rss\+xml/i.test(c.type));
  const best = rss ?? candidates[0];
  try {
    return new URL(best.href, baseUrl).toString();
  } catch {
    return null;
  }
}

async function resolveSubstackProfile(
  username: string,
): Promise<{ feedUrl: string; source: string } | null> {
  const profileUrl = `https://substack.com/@${username}`;
  let html = "";
  try {
    const r = await fetch(profileUrl, { headers: BROWSER_HEADERS, redirect: "follow" });
    if (r.ok) html = await r.text();
  } catch { /* ignore */ }

  const subRe = /https?:\/\/([a-z0-9][a-z0-9-]*)\.substack\.com\b/gi;
  const candidates = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = subRe.exec(html)) !== null) {
    const sub = m[1].toLowerCase();
    if (sub !== "www" && sub !== "on" && sub !== "open") candidates.add(sub);
  }
  candidates.add(username.toLowerCase());

  for (const sub of candidates) {
    const feedUrl = `https://${sub}.substack.com/feed`;
    const r = await probe(feedUrl);
    if (r.ok && isXmlContentType(r.contentType)) {
      return { feedUrl, source: "substack-publication" };
    }
  }

  const notesFeed = `https://substack.com/feed/@${username}`;
  const r = await probe(notesFeed);
  if (r.ok && isXmlContentType(r.contentType)) {
    return { feedUrl: notesFeed, source: "substack-notes" };
  }
  return null;
}

function ok(result: DiscoverFeedResult): NextResponse {
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=86400" },
  });
}

async function classify(raw: string): Promise<DiscoverFeedResult | { error: string; status: number }> {
  let u: URL;
  try { u = new URL(raw); } catch {
    return { error: "Invalid URL", status: 400 };
  }
  if (u.protocol !== "https:") {
    return { error: "Only https:// URLs are accepted", status: 400 };
  }
  const host = u.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return { error: "Private hosts not allowed", status: 400 };
  }

  if (isMajorNewsHost(host)) {
    return {
      kind: "site-filter",
      url: u.toString(),
      title: `Site search · ${host}`,
      note:
        `${host} routed via Google News + \`site:${host}\` so results are ` +
        `scoped to whichever holdings / themes you assign.`,
    };
  }

  const twitterMatch = u
    .toString()
    .match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  if (twitterMatch) {
    const handle = twitterMatch[1];
    if (!TWITTER_RESERVED.has(handle.toLowerCase())) {
      return {
        kind: "twitter",
        url: `https://x.com/${handle}`,
        title: `@${handle}`,
        note:
          `We'll poll @${handle}'s recent tweets and surface the ones ` +
          `that mention each holding / theme this source is scoped to.`,
      };
    }
  }

  const profileMatch = u.toString().match(/^https:\/\/(?:www\.)?substack\.com\/@([A-Za-z0-9_-]+)/i);
  if (profileMatch) {
    const resolved = await resolveSubstackProfile(profileMatch[1]);
    if (resolved) {
      return {
        kind: "substack",
        url: resolved.feedUrl,
        title: `@${profileMatch[1]} · substack`,
        note: `Resolved via ${resolved.source}.`,
      };
    }
    // fall through to site-filter
  }

  if (looksLikeFeedPath(u.toString())) {
    return { kind: "rss", url: u.toString(), title: host, note: "Accepted as-is." };
  }

  const head = await probe(u.toString());
  if (head.ok) {
    if (isXmlContentType(head.contentType)) {
      return { kind: "rss", url: head.finalUrl, title: host, note: "Feed content-type detected." };
    }
    if (head.response) {
      try {
        const html = await head.response.text();
        const discovered = findAutodiscoverLink(html, head.finalUrl);
        if (discovered) {
          return {
            kind: "rss",
            url: discovered,
            title: host,
            note: "Autodiscovered via <link rel='alternate'>.",
          };
        }
      } catch { /* fall through */ }
    }
  }

  const base = `${u.protocol}//${u.host}`;
  for (const path of FALLBACK_PATHS) {
    const guess = base + path;
    const r = await probe(guess);
    if (r.ok && isXmlContentType(r.contentType)) {
      return { kind: "rss", url: r.finalUrl, title: host, note: `Found via ${path} fallback.` };
    }
  }

  return {
    kind: "site-filter",
    url: u.toString(),
    title: `Site search · ${host}`,
    note:
      "No RSS feed found. We'll search Google News for items from " +
      `${host} that match the targets you scope this source to.`,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { url?: string };
    const raw = (body.url ?? "").trim();
    if (!raw) {
      return NextResponse.json({ error: "bad_request", message: "url required" }, { status: 400 });
    }
    const result = await classify(raw);
    if ("error" in result) {
      return NextResponse.json({ error: "bad_request", message: result.error }, { status: result.status });
    }
    return ok(result);
  } catch (e) {
    return NextResponse.json({ error: "server", message: (e as Error).message }, { status: 500 });
  }
}

// GET /api/discover-feed?url=… kept for easy curl testing. Matches the
// reference contract 1:1.
export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("url") ?? "").trim();
  if (!raw) {
    return NextResponse.json({ error: "bad_request", message: "url required" }, { status: 400 });
  }
  const result = await classify(raw);
  if ("error" in result) {
    return NextResponse.json({ error: "bad_request", message: result.error }, { status: result.status });
  }
  return ok(result);
}
