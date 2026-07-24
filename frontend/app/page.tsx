import { WatchlistTable } from "@/components/overview/WatchlistTable";
import { data } from "@/lib/data";

// Overview (default landing).
// Backend integration flag: rows are joined from /api/shared-state
// (watchlist) + /api/earnings per ticker in live mode.
export default function OverviewPage() {
  const rows = data.getWatchlist();
  return (
    <div className="mx-auto max-w-[1360px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Overview · Watchlist</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {rows.length} covered names · reporting picture as of today
        </h1>
      </div>
      <WatchlistTable rows={rows} />
    </div>
  );
}
