import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const entries = await store.readFeedback();
  return NextResponse.json(
    { schema: "feedback/v1", entries },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } },
  );
}
