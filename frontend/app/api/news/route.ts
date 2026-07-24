import { NextRequest, NextResponse } from "next/server";
import { fanoutNews, NEWS_CATEGORIES } from "@/server/vendors/news";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const result = await fanoutNews(q);
  return NextResponse.json(
    { ...result, categories: NEWS_CATEGORIES },
    {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1800" },
    },
  );
}
