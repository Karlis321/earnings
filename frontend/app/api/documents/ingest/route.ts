import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import { ingestDocument } from "@/server/lib/documentIngest";
import { urlHash } from "@/lib/itemDedupe";
import type { Provenance } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/documents/ingest
//
// Body:
//   url         required  https:// URL to ingest
//   provenance  optional  Provenance union; default "news"
//   source      optional  display label; default = URL host
//   language    optional  default "en"
//   publishedAt optional  ISO date string
//
// Behavior: fetches the URL, extracts body, sanitizes, injects paragraph
// anchors, segments transcripts, computes content hash. If a document at
// urlHash(url) already exists AND the content hash is unchanged, returns
// { ok: true, changed: false }. Otherwise bumps ingestVersion and writes.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const PROVENANCE_SET = new Set<Provenance>([
  "regulatory",
  "ir-page",
  "wire",
  "news",
  "social",
  "independent",
]);

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      url?: string;
      provenance?: Provenance;
      source?: string;
      language?: string;
      publishedAt?: string | null;
    };
    if (!body.url || typeof body.url !== "string") {
      return NextResponse.json(
        { error: "bad_request", message: "url required" },
        { status: 400 },
      );
    }
    let target: URL;
    try {
      target = new URL(body.url);
    } catch {
      return NextResponse.json(
        { error: "bad_request", message: "invalid URL" },
        { status: 400 },
      );
    }
    if (target.protocol !== "https:") {
      return NextResponse.json(
        { error: "bad_request", message: "only https:// URLs are accepted" },
        { status: 400 },
      );
    }
    if (body.provenance && !PROVENANCE_SET.has(body.provenance)) {
      return NextResponse.json(
        { error: "bad_request", message: `unknown provenance ${body.provenance}` },
        { status: 400 },
      );
    }

    if (store.mode() === "in-memory") {
      return NextResponse.json(
        {
          error: "persistence-unavailable",
          message:
            "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME so ingested docs can be committed.",
        },
        { status: 503 },
      );
    }

    const r = await fetch(target.toString(), {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "upstream", message: `${target.host} → ${r.status}` },
        { status: 502 },
      );
    }
    const raw = await r.text();

    const id = urlHash(target.toString());
    const existing = await store.readDocument(id);

    const { document, changed } = ingestDocument({
      url: target.toString(),
      rawHtml: raw,
      provenance: body.provenance ?? "news",
      source: body.source ?? target.host,
      language: body.language ?? "en",
      publishedAt: body.publishedAt ?? null,
      priorVersion: existing?.meta.ingestVersion,
      priorHash: existing?.meta.sourceContentHash,
    });

    if (!changed && existing) {
      return NextResponse.json({
        ok: true,
        id,
        changed: false,
        ingestVersion: existing.meta.ingestVersion,
        message: "content unchanged — no commit",
      });
    }

    await store.writeDocument(document);
    return NextResponse.json({
      ok: true,
      id,
      changed: true,
      ingestVersion: document.meta.ingestVersion,
      paragraphCount: document.meta.paragraphCount,
      kind: document.meta.kind,
      segments: document.meta.segments.length,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}
