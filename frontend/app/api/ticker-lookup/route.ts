import { NextRequest, NextResponse } from "next/server";
import { yahooLookup } from "@/server/vendors/yahoo";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") ?? sp.get("q") ?? "").trim();
  const exchange = (sp.get("exchange") ?? "US").trim();

  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }

  const result = await yahooLookup(symbol, exchange);
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json(result, {
    headers: { "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" },
  });
}
