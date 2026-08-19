import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import type { SharedState } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await store.readSharedState();
  return NextResponse.json(state, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
  });
}

// PUT /api/shared-state — write watchlist, custom sources, theme toggles.
// Body: full SharedState. Server stamps `lastCommit` on write.
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<SharedState>;
    if (body.schema && body.schema !== "shared-state/v1") {
      return NextResponse.json(
        { error: "bad_request", message: "schema must be shared-state/v1" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.watchlist)) {
      return NextResponse.json(
        { error: "bad_request", message: "watchlist must be an array of tickers" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.customSources)) {
      return NextResponse.json(
        { error: "bad_request", message: "customSources must be an array" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.themes)) {
      return NextResponse.json(
        { error: "bad_request", message: "themes must be an array" },
        { status: 400 },
      );
    }
    // preferences is optional during the schema-v1 migration. When
    // present it must have the three fields; missing → left off.
    if (body.preferences !== undefined) {
      const p = body.preferences;
      if (
        !p ||
        typeof p !== "object" ||
        !Array.isArray(p.focusTickers) ||
        !Array.isArray(p.themes) ||
        typeof p.subscriptions !== "object" ||
        p.subscriptions == null
      ) {
        return NextResponse.json(
          { error: "bad_request", message: "preferences must be { focusTickers[], themes[], subscriptions{} }" },
          { status: 400 },
        );
      }
    }
    if (store.mode() === "in-memory") {
      return NextResponse.json(
        {
          error: "persistence-unavailable",
          message: "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME in Vercel env.",
        },
        { status: 503 },
      );
    }
    const next: SharedState = {
      schema: "shared-state/v1",
      watchlist: body.watchlist,
      customSources: body.customSources,
      themes: body.themes,
      ...(body.preferences ? { preferences: body.preferences } : {}),
      lastCommit: new Date().toISOString(),
    };
    await store.writeSharedState(next);
    return NextResponse.json({ ok: true, lastCommit: next.lastCommit });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}
