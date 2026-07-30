import { NextRequest, NextResponse } from "next/server";
import { yahooSeries, yahooLookup } from "@/server/vendors/yahoo";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/prices?ticker=<Bloomberg>&range=1y
// or  /api/prices?symbol=<Yahoo>&range=1y
// Returns daily closes for the requested horizon.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const range = sp.get("range") ?? "1y";
  const interval = sp.get("interval") ?? "1d";
  let symbol = sp.get("symbol");

  if (!symbol) {
    const ticker = sp.get("ticker");
    if (!ticker) {
      return NextResponse.json(
        { error: "Provide ?symbol=<Yahoo> or ?ticker=<Bloomberg>" },
        { status: 400 },
      );
    }
    // Prefer the entity's persisted yahooSymbol from the registry.
    // Bloomberg-code parsing via yahooLookup is a fragile fallback:
    // SHLE CN → search returns "No tradable SHLE on CN" because "CN"
    // is Canada, not a Yahoo exchange suffix. The correct symbol is
    // SHLE.TO — which the registry already knows on every entity.
    // Only fall back to search when the entity isn't in the registry
    // or has no persisted yahooSymbol.
    try {
      const entities = await store.readRegistry();
      const entity = entities.find((e) => e.ticker === ticker);
      if (entity?.yahooSymbol) symbol = entity.yahooSymbol;
    } catch {
      /* registry read failed — fall through to search */
    }
    if (!symbol) {
      const parts = ticker.split(/\s+/);
      const bbSymbol = parts[0];
      const bbExchange = parts[1] ?? "US";
      const resolved = await yahooLookup(bbSymbol, bbExchange);
      if ("error" in resolved) {
        return NextResponse.json(
          { error: `Cannot resolve ${ticker}: ${resolved.error}` },
          { status: resolved.status },
        );
      }
      symbol = resolved.yahooSymbol;
    }
  }

  const series = await yahooSeries(symbol, range, interval);
  if (series.length === 0) {
    return NextResponse.json(
      { error: `No data for ${symbol}`, symbol, series: [] },
      { status: 404 },
    );
  }
  return NextResponse.json(
    { symbol, range, interval, series, fetchedAt: new Date().toISOString() },
    {
      // 5-min edge cache so users always see prices within the last
      // trading interval — bumps intraday freshness while still shielding
      // Yahoo from thundering-herd traffic. stale-while-revalidate keeps
      // response times fast during the refresh window.
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=900",
      },
    },
  );
}
