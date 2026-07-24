import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const snap = await store.readEarnings();
  return NextResponse.json(snap, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
  });
}
