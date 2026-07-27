import { NextRequest, NextResponse } from "next/server";
import { fetchTweets } from "@/server/vendors/tweets";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/tweets?ticker=<Bloomberg>
//
// TwitterAPI.io only (per DC15: Nitter dropped, no Cloudflare Worker for v1).
// When TWITTERAPI_IO_KEY is unset the engine reports ok=false, itemsFound=0
// and returns an empty items list. Siblings in the orchestrator keep running.
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json(
      { error: "bad_request", message: "?ticker=<Bloomberg-style> required" },
      { status: 400 },
    );
  }
  const registry = await store.readRegistry();
  const entity = registry.find((e) => e.ticker === ticker);
  if (!entity) {
    return NextResponse.json(
      { error: "not_found", message: `no entity ${ticker}` },
      { status: 404 },
    );
  }
  const result = await fetchTweets(entity);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=3600" },
  });
}
