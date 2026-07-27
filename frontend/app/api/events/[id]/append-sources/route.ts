import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import type { EngineStatus, SourceItem } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// POST /api/events/:id/append-sources
//
// Idempotent append. Dedupe by item.id happens in the store layer
// (gitSnapshot.appendEventSources filters new items against seen ids
// on the event). Replaying the same POST is a no-op.
//
// Body:
//   items: SourceItem[]           — merged/deduped list from the orchestrator
//   engineStatus: EngineStatus[]  — per-engine run status; replaces prior status
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as {
      items?: SourceItem[];
      engineStatus?: EngineStatus[];
    };
    if (!Array.isArray(body.items)) {
      return NextResponse.json(
        { error: "bad_request", message: "items must be an array" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.engineStatus)) {
      return NextResponse.json(
        { error: "bad_request", message: "engineStatus must be an array" },
        { status: 400 },
      );
    }
    // Basic shape guard on items so a malformed payload doesn't corrupt
    // the snapshot.
    for (const it of body.items) {
      if (!it.id || !it.url || !it.headline) {
        return NextResponse.json(
          {
            error: "bad_request",
            message: "each item requires id, url, headline",
          },
          { status: 400 },
        );
      }
    }
    if (store.mode() === "in-memory") {
      return NextResponse.json(
        {
          error: "persistence-unavailable",
          message:
            "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME in Vercel env to enable writes.",
        },
        { status: 503 },
      );
    }
    // The store guards against duplicate item.id, so callers can safely
    // POST the full merged list on every refresh cycle.
    const snap = await store.readEarnings();
    const event = snap.events.find((e) => e.id === id);
    if (!event) {
      return NextResponse.json(
        { error: "not_found", message: `no event ${id}` },
        { status: 404 },
      );
    }
    await store.appendEventSources(id, body.items, body.engineStatus);
    // Report back how many are new so the UI can toast a real number.
    const seen = new Set(event.sources.items.map((i) => i.id));
    const newlyAdded = body.items.filter((i) => !seen.has(i.id)).length;
    return NextResponse.json({ ok: true, appended: newlyAdded });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json(
        { error: "conflict", message: msg },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "server", message: msg },
      { status: 500 },
    );
  }
}
