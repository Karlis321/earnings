import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/news/resolve?url=<gnews-url>
//
// Follows the Google News redirect chain server-side and returns the
// final publisher URL. Called by SourceViewer when a shard item's URL
// still points at news.google.com/rss/articles/<base64> — the cron-time
// resolver in server/vendors/news.ts sometimes silently fails (HEAD
// unsupported, network hiccup) and the item keeps the redirector URL
// even though its normalized publisher already reads e.g. "Yahoo
// Finance". Users then click and see "news.google.com refused to
// connect" (X-Frame-Options block).
//
// Resolution rules:
//   - Only follow when the input URL's host is news.google.com (safety).
//   - Uses a browser-like UA so aggressive gates (403 on wget-shaped UAs)
//     don't turn a working redirect into a 200-page-of-nothing.
//   - Bounded to a single upstream fetch with an 8s timeout.
//   - Returns { resolved: string, changed: boolean } on success; 502 on
//     upstream failure so the client can fall back to the original URL.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) {
    return NextResponse.json(
      { error: "bad_request", message: "?url= required" },
      { status: 400 },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "invalid URL" },
      { status: 400 },
    );
  }
  const host = parsed.host.toLowerCase();
  if (host !== "news.google.com") {
    // No-op passthrough for non-gnews URLs so the client can call this
    // unconditionally without a host check.
    return NextResponse.json({ resolved: raw, changed: false });
  }

  try {
    const r = await fetch(raw, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
    });
    // r.url is the final URL after redirects. If it still looks like a
    // Google News URL, the redirect didn't unwind — return original so
    // the client shows a clean "Open at publisher" instead of iframing
    // a blocked page.
    const final = r.url ?? raw;
    if (new URL(final).host.toLowerCase() === "news.google.com") {
      return NextResponse.json(
        { error: "unresolved", message: "redirect did not unwind" },
        { status: 502 },
      );
    }
    return NextResponse.json({ resolved: final, changed: final !== raw });
  } catch (e) {
    return NextResponse.json(
      { error: "server", message: (e as Error).message },
      { status: 502 },
    );
  }
}
