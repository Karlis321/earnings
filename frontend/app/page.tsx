import { WatchlistTable } from "@/components/overview/WatchlistTable";
import { data } from "@/lib/data";

// Overview (default landing). FE PRD §7.2.
// Backend integration flag (P4-T5): rows are joined from /api/shared-state
// (watchlist) + /api/earnings per ticker in live mode.
export default function OverviewPage() {
  const rows = data.getWatchlist();
  return (
    <div className="mx-auto max-w-[1360px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Overview · Watchlist</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          17 covered names · reporting picture as of today
        </h1>
        <p className="mt-2 max-w-[64ch] text-[13.5px] leading-[1.6] text-tx2">
          The full book at a glance — operating, developer, and ETF, with the
          next event, last surprise, guidance move, and a compact reaction
          sparkline. Every number is sourced; click a row to open the security.
        </p>
      </div>
      <WatchlistTable rows={rows} />
    </div>
  );
}
