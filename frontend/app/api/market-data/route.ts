import { NextResponse } from "next/server";
import { fetchAllMarketData } from "@/server/vendors/marketData";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const data = await fetchAllMarketData();
  return NextResponse.json(data, {
    headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=900" },
  });
}
