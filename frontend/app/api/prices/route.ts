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

  let series = await yahooSeries(symbol, range, interval);
  let widenedTo: string | null = null;
  // Auto-widen when Yahoo returns a suspiciously thin series for the
  // requested range. Some low-volume foreign listings (ABXX.NE on
  // Canada's NEO, Indonesian .JK small-caps, etc.) return just 1-2
  // bars at range=1mo but a full history at range=3mo or wider. Rather
  // than dead-ending with 'No price data' when there IS data, retry
  // once at a wider range. Threshold: <5 bars for daily interval.
  if (interval === "1d" && series.length < 5) {
    const widerMap: Record<string, string> = {
      "1mo": "3mo",
      "3mo": "6mo",
      "6mo": "1y",
    };
    const wider = widerMap[range];
    if (wider) {
      const retry = await yahooSeries(symbol, wider, interval);
      if (retry.length > series.length) {
        series = retry;
        widenedTo = wider;
      }
    }
  }
  if (series.length === 0) {
    return NextResponse.json(
      { error: `No data for ${symbol}`, symbol, series: [] },
      { status: 404 },
    );
  }
  return NextResponse.json(
    { symbol, range: widenedTo ?? range, interval, series, widenedFrom: widenedTo ? range : undefined, fetchedAt: new Date().toISOString() },
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
