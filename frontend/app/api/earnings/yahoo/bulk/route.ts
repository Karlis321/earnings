import { NextRequest, NextResponse } from "next/server";
import {
  yahooLookup,
  yahooEarnings,
  type YahooEarnings,
} from "@/server/vendors/yahoo";

// GET /api/earnings/yahoo/bulk?tickers=INTC+US,NVDA+US,...
//
// Returns per-ticker { nextEarningsDate, lastQuarter, currentQuarterEstimate }
// pulled from Yahoo quoteSummary. Used by the overview watchlist to fill in
// surprise / next-event / guidance columns for tickers without fixture events.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CONCURRENCY = 4;

async function pool<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Entry {
  ok: boolean;
  data?: YahooEarnings;
  err?: string;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("tickers");
  if (!raw) {
    return NextResponse.json(
      { error: "bad_request", message: "?tickers=<comma-separated>" },
      { status: 400 },
    );
  }
  const tickers = raw
    .split(",")
    .map((t) => decodeURIComponent(t).trim())
    .filter(Boolean);

  const results = await pool<string, [string, Entry]>(
    tickers,
    CONCURRENCY,
    async (t): Promise<[string, Entry]> => {
      try {
        const [sym, exch = "US"] = t.split(/\s+/);
        const resolved = await yahooLookup(sym, exch);
        if ("error" in resolved) {
          return [t, { ok: false, err: resolved.error }];
        }
        const data = await yahooEarnings(resolved.yahooSymbol);
        if (!data) return [t, { ok: false, err: "no earnings data" }];
        return [t, { ok: true, data }];
      } catch (e) {
        return [t, { ok: false, err: (e as Error).message }];
      }
    },
  );

  const map: Record<string, Entry> = {};
  for (const [t, entry] of results) map[t] = entry;

  return NextResponse.json(
    { fetchedAt: new Date().toISOString(), tickers: map },
    {
      headers: {
        // 5-min edge cache so watchlist rows reflect today's Yahoo
        // calendar + last-quarter EPS actual (updates as companies report).
        "Cache-Control": "s-maxage=300, stale-while-revalidate=900",
      },
    },
  );
}
