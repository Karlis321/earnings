import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import type { Entity } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ ticker: string }> };

function persistenceUnavailable() {
  return NextResponse.json(
    {
      error: "persistence-unavailable",
      message: "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME in Vercel env.",
    },
    { status: 503 },
  );
}

// PUT /api/entity-registry/:ticker — merge patch by ticker key.
// Body may be a partial Entity; the `ticker` field on the entity itself
// stays pinned to the URL param even if a rename is attempted (rename
// requires DELETE + POST to keep historical events consistent).
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { ticker } = await ctx.params;
    const body = (await req.json()) as Partial<Entity>;
    if (store.mode() === "in-memory") return persistenceUnavailable();

    const existing = await store.readRegistry();
    const idx = existing.findIndex((e) => e.ticker === ticker);
    if (idx < 0) {
      return NextResponse.json(
        { error: "not_found", message: `${ticker} not in registry` },
        { status: 404 },
      );
    }
    const merged: Entity = { ...existing[idx], ...body, ticker };
    const next = existing.slice();
    next[idx] = merged;
    await store.writeRegistry(next);
    return NextResponse.json({ ok: true, ticker });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}

// DELETE /api/entity-registry/:ticker — drop from registry.
// Historical events in earnings.json are left intact (their ticker still
// resolves for /s/:ticker deep links to prior prints).
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { ticker } = await ctx.params;
    if (store.mode() === "in-memory") return persistenceUnavailable();

    const existing = await store.readRegistry();
    const idx = existing.findIndex((e) => e.ticker === ticker);
    if (idx < 0) {
      return NextResponse.json(
        { error: "not_found", message: `${ticker} not in registry` },
        { status: 404 },
      );
    }
    const next = existing.filter((e) => e.ticker !== ticker);
    await store.writeRegistry(next);
    return NextResponse.json({ ok: true, ticker });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}
