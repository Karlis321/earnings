import { NextRequest, NextResponse } from "next/server";
import { fanoutNews, fetchEntityNews, NEWS_CATEGORIES } from "@/server/vendors/news";
import { store } from "@/server/store";
import { tickerSearchTokens } from "@/lib/tickerMatch";
import { normalizeNewsItems } from "@/server/lib/newsNormalize";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/news
//   ?q=<free text>         — old behavior, strict substring pre-filter
//   ?ticker=<Bloomberg>    — resolve entity in registry, use fetchEntityNews
//                             for a targeted Google-News RSS OR-query over
//                             aliases + cashtag + Yahoo-suffix forms
//   ?days=<n>              — window, default 14 (was 7)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = sp.get("ticker");
  const q = sp.get("q") ?? undefined;
  const daysRaw = sp.get("days");
  const days = daysRaw ? Math.max(1, Math.min(365, parseInt(daysRaw, 10) || 14)) : 14;

  // Entity-targeted path: return the aliased OR-query results for this
  // ticker so the security detail news panel isn't at the mercy of the
  // strict displayName substring pre-filter.
  if (ticker) {
    const registry = await store.readRegistry();
    const entity = registry.find((e) => e.ticker === ticker);
    if (!entity) {
      return NextResponse.json(
        { error: "unknown_ticker", message: `${ticker} not in registry` },
        { status: 404 },
      );
    }
    const tokens = tickerSearchTokens(entity);
    const result = await fetchEntityNews(entity.ticker, tokens, days);
    // Normalize before returning — clean publisher / title split,
    // dedup, newest-first ordering, guaranteed shape.
    const items = normalizeNewsItems(result.items ?? []);
    return NextResponse.json(
      { ...result, items, categories: NEWS_CATEGORIES, days },
      {
        headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1800" },
      },
    );
  }

  // Free-text query — old behavior
  const result = await fanoutNews({ query: q, days });
  const items = normalizeNewsItems(result.items ?? []);
  return NextResponse.json(
    { ...result, items, categories: NEWS_CATEGORIES, days },
    {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1800" },
    },
  );
}
