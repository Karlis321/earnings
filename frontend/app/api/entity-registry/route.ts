import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import type { Entity } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const entities = await store.readRegistry();
  return NextResponse.json(
    { schema: "entity-registry/v1", entities },
    { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } },
  );
}

// POST /api/entity-registry — create a new entity.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<Entity>;
    if (!body.ticker || !body.displayName || !body.securityType) {
      return NextResponse.json(
        { error: "bad_request", message: "ticker, displayName, securityType required" },
        { status: 400 },
      );
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
    const existing = await store.readRegistry();
    if (existing.some((e) => e.ticker === body.ticker)) {
      return NextResponse.json(
        { error: "conflict", message: `${body.ticker} already exists` },
        { status: 409 },
      );
    }
    // Fill required fields with sane defaults where missing.
    const entity: Entity = {
      ticker: body.ticker,
      legalName: body.legalName ?? body.displayName,
      displayName: body.displayName,
      aliases: body.aliases ?? [],
      exclusionAliases: body.exclusionAliases ?? [],
      sectorTags: body.sectorTags ?? [],
      cashtag: body.cashtag ?? null,
      isCore: body.isCore ?? true,
      securityType: body.securityType,
      coverage: body.coverage ?? "deep",
      listing: body.listing ?? "",
      currency: body.currency ?? "USD",
      benchmark: body.benchmark ?? "",
      headlineMetrics: body.headlineMetrics ?? [],
      catalystTypes: body.catalystTypes ?? [],
    };
    await store.writeRegistry([...existing, entity]);
    return NextResponse.json({ ok: true, ticker: entity.ticker });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}
