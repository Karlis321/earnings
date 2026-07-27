import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/documents/:id
// Returns { schema, meta: DocumentMeta, html } for an ingested document.
// 404 when the id isn't in the store — the SourceViewer treats that as
// "not hosted" and falls back to iframe / link-out.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const doc = await store.readDocument(id);
  if (!doc) {
    return NextResponse.json(
      { error: "not_found", message: `no document ${id}` },
      { status: 404 },
    );
  }
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400",
      // Hosted-mode content is rendered inside our own origin via
      // dangerouslySetInnerHTML — same-origin CSP applies. Images may
      // load from the source publisher.
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'none'; frame-src 'none';",
    },
  });
}
