// SP500 + R1000 + portfolio filter added in commit fe87af70; cache-buster
// comment below because Vercel didn't rebuild this route on the first push.
import { WatchlistTable } from "@/components/overview/WatchlistTable";
import { MarketPulse } from "@/components/overview/MarketPulse";
import { MoversStrip, type MoverRow } from "@/components/overview/MoversStrip";
import { NextFiresStrip } from "@/components/shell/NextFiresStrip";
import { store } from "@/server/store";
import { buildWatchlistRowsFromIndex } from "@/lib/watchlist";
import { todayIso } from "@/lib/freshness";
import { isDisplayable } from "@/lib/displayFilter";
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
  const [entities, index, state, blueOcean, ruleBreaker] = await Promise.all([
    store.readRegistry(),
    store.readEventsIndex?.() ?? Promise.resolve(EMPTY_INDEX),
    store.readSharedState(),
    store.readScreen
      ? store.readScreen("blue-ocean")
      : Promise.resolve(null),
    store.readScreen
      ? store.readScreen("rule-breaker")
      : Promise.resolve(null),
  ]);
  const focusTickers = state.preferences?.focusTickers ?? [];
  // Framework scores (Feature 4C) — slim projection. Empty when the
  // framework-screen workflow hasn't landed for a ticker yet (chip
  // auto-hides on absence).
  const frameworkByTicker: Record<
    string,
    { bo?: number; rb?: number }
  > = {};
  for (const s of blueOcean?.screens ?? []) {
    frameworkByTicker[s.ticker] = {
      ...frameworkByTicker[s.ticker],
      bo: s.compositeScore,
    };
  }
  for (const s of ruleBreaker?.screens ?? []) {
    frameworkByTicker[s.ticker] = {
      ...frameworkByTicker[s.ticker],
      rb: s.compositeScore,
    };
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

  // Big movers strip — top-N by |d3 reaction| over the last 45 days
  // across the same SP500 ∪ R1000 ∪ isCore universe. Uses fields
  // already denormalized onto events-index; no new data path.
  //
  // Split-artifact guard: a stock split landing inside the reaction
  // window makes d3 jump by ~50% vs. d1 (Yahoo bars flip between
  // un-adjusted and split-adjusted). Real reactions stay similar in
  // magnitude across horizons. So we drop events where d1 and d3
  // diverge by more than 30 percentage points AND d1 itself is
  // within the normal earnings-reaction range (≤ 25%). Example:
  // MNST US 2026-08-06 showed d1=-4%, d3=-51% after a 2:1 split.
  const MOVERS_WINDOW_DAYS = 45;
  const SPLIT_DIVERGENCE_PP = 0.30;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - MOVERS_WINDOW_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const byTicker = new Map(entities.map((e) => [e.ticker, e]));
  const moverRows: MoverRow[] = [];
  for (const entry of index.entries) {
    if (!entry.lastEventDate || entry.lastEventDate < cutoffIso) continue;
    const ent = byTicker.get(entry.ticker);
    if (!ent) continue;
    if (!isDisplayable(ent)) continue;
    if (ent.securityType !== "operating") continue;
    const mem = ent.index_membership ?? [];
    if (!ent.isCore && !mem.includes("SP500") && !mem.includes("R1000")) continue;
    const points = entry.lastEventReactionPoints ?? [];
    const d3 = points.find((p) => p.horizon === "d3" && p.absReturn != null);
    const d1 = points.find((p) => p.horizon === "d1" && p.absReturn != null);
    if (!d3) continue;
    if (d1 && d1.absReturn != null) {
      const gap = Math.abs((d3.absReturn as number) - (d1.absReturn as number));
      if (gap > SPLIT_DIVERGENCE_PP && Math.abs(d1.absReturn as number) < 0.25) continue;
    }
    moverRows.push({
      ticker: entry.ticker,
      displayName: ent.displayName,
      capTier: ent.capTier ?? "unknown",
      period: entry.lastPeriod ?? "—",
      eventDate: entry.lastEventDate,
      absD3: d3.absReturn as number,
      excessD3: d3.excessReturn ?? null,
      surprisePct: entry.lastSurprisePct ?? null,
    });
  }
  moverRows.sort((a, b) => Math.abs(b.absD3) - Math.abs(a.absD3));
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
      <MoversStrip rows={moverRows} />
      <WatchlistTable
        rows={rows}
        focusTickers={focusTickers}
        frameworkByTicker={frameworkByTicker}
      />
    </div>
  );
}
