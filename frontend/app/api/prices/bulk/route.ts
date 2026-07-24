import { NextRequest, NextResponse } from "next/server";
import { yahooLookup, yahooSeries } from "@/server/vendors/yahoo";

// GET /api/prices/bulk?tickers=INTC+US,NVDA+US,...&range=1mo
//
// Server-side fan-out over multiple Bloomberg-style tickers. Resolves each
// via Yahoo query2 search, pulls the daily-close series from v8 chart in
// parallel (small concurrency cap to be gentle on Yahoo).
//
// Response:
//   {
//     range, fetchedAt,
//     tickers: {
//       [bloombergTicker]: {
//         yahooSymbol, name, ok,
//         series: [{ date, close }, ...]  (or [] on error)
//         change, pctChange, latest, first,
//         err?  (only set when ok=false)
//       }
//     }
//   }
//
// Overview rows consume this to render real 1-month sparklines.

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

interface OneOk {
  ok: true;
  yahooSymbol: string;
  name: string;
  series: { date: string; close: number }[];
  first: number;
  latest: number;
  change: number;
  pctChange: number;
}
interface OneErr {
  ok: false;
  err: string;
  series: [];
}
type One = OneOk | OneErr;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const raw = sp.get("tickers");
  const range = sp.get("range") ?? "1mo";
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

  const results = await pool<string, [string, One]>(
    tickers,
    CONCURRENCY,
    async (t): Promise<[string, One]> => {
      try {
        const parts = t.split(/\s+/);
        const sym = parts[0];
        const exch = parts[1] ?? "US";
        const resolved = await yahooLookup(sym, exch);
        if ("error" in resolved) {
          return [t, { ok: false as const, err: resolved.error, series: [] }];
        }
        const series = await yahooSeries(resolved.yahooSymbol, range);
        if (series.length < 2) {
          return [
            t,
            { ok: false as const, err: "no series data", series: [] },
          ];
        }
        const first = series[0].close;
        const latest = series[series.length - 1].close;
        return [
          t,
          {
            ok: true as const,
            yahooSymbol: resolved.yahooSymbol,
            name: resolved.name,
            series,
            first,
            latest,
            change: latest - first,
            pctChange: ((latest - first) / first) * 100,
          },
        ];
      } catch (e) {
        return [
          t,
          { ok: false as const, err: (e as Error).message, series: [] },
        ];
      }
    },
  );

  const map: Record<string, One> = {};
  for (const [t, one] of results) map[t] = one;

  return NextResponse.json(
    { range, fetchedAt: new Date().toISOString(), tickers: map },
    { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=900" } },
  );
}
