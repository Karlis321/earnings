// SP500 + R1000 + portfolio filter added in commit fe87af70; cache-buster
// comment below because Vercel didn't rebuild this route on the first push.
import { WatchlistTable } from "@/components/overview/WatchlistTable";
import { MarketPulse } from "@/components/overview/MarketPulse";
import { NextFiresStrip } from "@/components/shell/NextFiresStrip";
import { store } from "@/server/store";
import { buildWatchlistRowsFromIndex } from "@/lib/watchlist";
import { todayIso } from "@/lib/freshness";
import type { EventsIndex } from "@/lib/types";

// W8 cutover: home page reads from the store, not fixtures. The 60s
// git-snapshot read cache keeps this cheap when the same request renders
// multiple pages / the header pill. Reads the lightweight
// data/events-index.json instead of the whole earnings monolith.
export const dynamic = "force-dynamic";

const EMPTY_INDEX: EventsIndex = {
  schema: "events-index/v1",
  updatedAt: "",
  entries: [],
};

export default async function OverviewPage() {
  const [entities, index, state, ranking] = await Promise.all([
    store.readRegistry(),
    store.readEventsIndex?.() ?? Promise.resolve(EMPTY_INDEX),
    store.readSharedState(),
    store.readRanking ? store.readRanking() : Promise.resolve(null),
  ]);
  const focusTickers = state.preferences?.focusTickers ?? [];
  // Slim map of ticker → composite score for the watchlist chip.
  // Only 2 fields per entry keeps the payload cheap even at 1,006 rows.
  const compositeByTicker: Record<string, number> = {};
  for (const r of ranking?.rows ?? []) {
    compositeByTicker[r.ticker] = r.compositeScore;
  }
  const allRows = buildWatchlistRowsFromIndex(entities, index.entries, todayIso());
  // Filter to portfolio (always visible) + SP500 + R1000 constituents.
  // Per user directive (2026-08-19): no dashboard surface should list
  // tickers outside the two big US indexes unless they're on the
  // portfolio. Applies uniformly with the sector-page filter.
  const rows = allRows.filter((r) => {
    if (r.entity.isCore) return true;
    const mem = r.entity.index_membership ?? [];
    return mem.includes("SP500") || mem.includes("R1000");
  });
  const coreCount = rows.filter((r) => r.entity.isCore).length;
  const universeCount = rows.length - coreCount;
  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <MarketPulse />
      <NextFiresStrip />
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Overview · Watchlist</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {coreCount} portfolio names · reporting picture as of today
        </h1>
        {universeCount > 0 ? (
          <p className="mt-1 text-[13px] text-tx-mid">
            + {universeCount} sector-universe names — switch tabs below to
            browse, or open <a href="/admin" className="text-brand-fg hover:underline">/admin</a> to
            manage.
          </p>
        ) : null}
      </div>
      <WatchlistTable
        rows={rows}
        focusTickers={focusTickers}
        compositeByTicker={compositeByTicker}
      />
    </div>
  );
}
