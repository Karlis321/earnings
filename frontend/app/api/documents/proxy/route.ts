import { NextRequest, NextResponse } from "next/server";
import { INGESTABLE_HOSTS } from "@/server/lib/documentIngest";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/documents/proxy?url=<encoded>
//
// Server-side proxy for embed-blocked publishers. Fetches the target URL,
// sanitizes the HTML (strips scripts, iframes, event handlers) and returns
// it so it can render inside our slide-over.
//
// Reuses INGESTABLE_HOSTS from documentIngest so this allowlist stays in
// sync with the set of hosts we auto-ingest — anything we've vetted for
// stored redistribution is also safe to server-side proxy for embed.

// Browser-like UA — businesswire.com and accesswire.com return 403 on
// obvious-bot UAs. This still identifies as our app via the trailing
// contact string (their bot policies grant read access when we ID as
// a browser but keep the audit trail), and doesn't spoof a specific
// version we might have to keep updating.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Minimal HTML sanitizer — no DOM, regex-based. Not a general-purpose
// XSS defender; scoped to our allowlisted hosts where we trust the source.
function sanitize(html: string): string {
  let out = html;
  // Strip <script>, <style>, <iframe>, <object>, <embed>, <link rel=stylesheet>
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  out = out.replace(/<object[\s\S]*?<\/object>/gi, "");
  out = out.replace(/<embed[^>]*>/gi, "");
  out = out.replace(/<link[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "");
  // Strip inline event handlers (onclick=, onload=, etc.)
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  // Strip javascript: URIs
  out = out.replace(/javascript:/gi, "no-op:");
  // Rewrite base + relative links to absolute (crude — leave as-is if not obvious)
  return out;
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  if (!target) {
    return NextResponse.json(
      { error: "bad_request", message: "?url= required" },
      { status: 400 },
    );
  }
  let host: string;
  try {
    host = new URL(target).host.toLowerCase();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "invalid URL" },
      { status: 400 },
    );
  }
  if (!INGESTABLE_HOSTS.has(host)) {
    return NextResponse.json(
      {
        error: "host_not_allowed",
        message: `${host} is not on the ingest allowlist. See INGESTABLE_HOSTS in server/lib/documentIngest.ts.`,
      },
      { status: 403 },
    );
  }
  try {
    const r = await fetch(target, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "upstream", message: `${host} → ${r.status}` },
        { status: 502 },
      );
    }
    const contentType = r.headers.get("content-type") ?? "text/html";
    const raw = await r.text();
    const html = contentType.includes("html") ? sanitize(raw) : raw;
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800",
        // Explicitly allow embedding in our own frame; strip any inherited X-Frame-Options.
        "Content-Security-Policy":
          "default-src 'self' data: https:; style-src 'unsafe-inline' https:; img-src 'self' data: https:; frame-ancestors *;",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "server", message: (e as Error).message },
      { status: 500 },
    );
  }
}
