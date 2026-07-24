import { NextRequest, NextResponse } from "next/server";
import { fetchPressReleases } from "@/server/vendors/pressReleases";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/press-releases?ticker=<Bloomberg>
// Returns the ticker's official press releases + regulatory filings.
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json(
      { error: "bad_request", message: "?ticker=<Bloomberg-style> required" },
      { status: 400 },
    );
  }
  const result = await fetchPressReleases(ticker);
  return NextResponse.json(result, {
    headers: {
      "Cache-Control": "s-maxage=600, stale-while-revalidate=1800",
    },
  });
}
