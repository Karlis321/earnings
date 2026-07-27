import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import type { MetricDictionary } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const dict = await store.readDictionary();
  return NextResponse.json(dict, {
    headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" },
  });
}

// POST /api/metric-dictionary — escape hatch for the gated dictionary.
// Body: { key, label, unit, requiresIsAdjusted?, description? }.
// Keys must be lowercase snake — matches the fixture convention.
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      key?: string;
      label?: string;
      unit?: string;
      requiresIsAdjusted?: boolean;
      description?: string | null;
    };
    const errors: Record<string, string> = {};
    if (!body.key || typeof body.key !== "string" || !KEY_RE.test(body.key)) {
      errors.key = "lowercase snake_case, starts with a letter, ≤64 chars";
    }
    if (!body.label || typeof body.label !== "string") {
      errors.label = "label required";
    }
    if (!body.unit || typeof body.unit !== "string") {
      errors.unit = "unit required";
    }
    if (Object.keys(errors).length) {
      return NextResponse.json(
        { error: "bad_request", fields: errors },
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
    const current = await store.readDictionary();
    if (current.metrics[body.key!]) {
      return NextResponse.json(
        { error: "conflict", message: `metric ${body.key} already exists` },
        { status: 409 },
      );
    }
    const next: MetricDictionary = {
      schema: "metric-dictionary/v1",
      metrics: {
        ...current.metrics,
        [body.key!]: {
          label: body.label!,
          unit: body.unit!,
          requiresIsAdjusted: Boolean(body.requiresIsAdjusted),
          description: body.description ?? null,
        },
      },
    };
    await store.writeDictionary(next);
    return NextResponse.json({ ok: true, key: body.key });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}
