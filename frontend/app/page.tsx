import { WatchlistTable } from "@/components/overview/WatchlistTable";
import { MarketPulse } from "@/components/overview/MarketPulse";
import { store } from "@/server/store";
import { buildWatchlistRows } from "@/lib/watchlist";
import { TODAY_ISO } from "@/lib/freshness";

// W8 cutover: home page reads from the store, not fixtures. The 60s
// git-snapshot read cache keeps this cheap when the same request renders
// multiple pages / the header pill.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [entities, snapshot] = await Promise.all([
    store.readRegistry(),
    store.readEarnings(),
  ]);
  const rows = buildWatchlistRows(entities, snapshot, TODAY_ISO);
  const coreCount = rows.filter((r) => r.entity.isCore).length;
  const universeCount = rows.length - coreCount;
  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <MarketPulse />
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
      <WatchlistTable rows={rows} />
    </div>
  );
}
