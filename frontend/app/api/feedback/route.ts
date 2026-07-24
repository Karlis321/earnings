import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import type { FeedbackEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const entries = await store.readFeedback();
  return NextResponse.json(
    { schema: "feedback/v1", entries },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<FeedbackEntry>;
    if (!body.target || !body.targetId || !body.action) {
      return NextResponse.json(
        { error: "bad_request", message: "target, targetId, action required" },
        { status: 400 },
      );
    }
    if (store.mode() === "in-memory") {
      return NextResponse.json(
        {
          error: "persistence-unavailable",
          message:
            "GH_PAT is not set on the deployment. Writes go through the GitHub commit-pipe when configured.",
        },
        { status: 503 },
      );
    }
    const entry: FeedbackEntry = {
      id: Math.random().toString(36).slice(2, 10),
      target: body.target,
      targetId: body.targetId,
      action: body.action,
      createdBy: "user",
      createdAt: new Date().toISOString(),
    };
    await store.appendFeedback(entry);
    return NextResponse.json({ ok: true, id: entry.id });
  } catch (e) {
    return NextResponse.json(
      { error: "server", message: (e as Error).message },
      { status: 500 },
    );
  }
}
