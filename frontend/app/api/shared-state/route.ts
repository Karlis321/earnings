import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await store.readSharedState();
  return NextResponse.json(state, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
  });
}
