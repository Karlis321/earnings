import { NextRequest, NextResponse } from "next/server";
import { fanoutNews, NEWS_CATEGORIES } from "@/server/vendors/news";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") ?? undefined;
  const daysRaw = sp.get("days");
  const days = daysRaw ? Math.max(1, Math.min(365, parseInt(daysRaw, 10) || 7)) : 7;
  const result = await fanoutNews({ query: q, days });
  return NextResponse.json(
    { ...result, categories: NEWS_CATEGORIES, days },
    {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1800" },
    },
  );
}
