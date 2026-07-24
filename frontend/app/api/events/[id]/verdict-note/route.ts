import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as { text?: string };
    if (typeof body.text !== "string") {
      return NextResponse.json(
        { error: "bad_request", message: "text (string) required" },
        { status: 400 },
      );
    }
    if (store.mode() === "in-memory") {
      return NextResponse.json(
        {
          error: "persistence-unavailable",
          message: "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME in Vercel env to enable writes.",
        },
        { status: 503 },
      );
    }
    await store.setVerdictNote(id, body.text);
    return NextResponse.json({
      ok: true,
      lastEditedAt: new Date().toISOString(),
    });
  } catch (e) {
    const msg = (e as Error).message;
    // 409 storm passed through
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
