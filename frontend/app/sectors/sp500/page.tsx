// S&P 500 grouping view. Not a sector — an index membership.
// Members keep their real GICS sectors and industry groups; this page
// filters by entity.index_membership.includes("SP500") and sub-groups
// by industryGroup, cap-descending inside each group.
//
// Companion to /sectors/[sectorId]/page.tsx, but distinct so the
// sub-grouping (industryGroup rather than a single flat list) has
// a natural home. Both surfaces load through the same store readers.

import { store } from "@/server/store";
import { buildWatchlistRowsFromIndex } from "@/lib/watchlist";
import { todayIso } from "@/lib/freshness";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import { SectorGroupsFilter } from "@/components/sectors/SectorGroupsFilter";
import type { EventsIndex } from "@/lib/types";

export const dynamic = "force-dynamic";

const EMPTY_INDEX: EventsIndex = {
  schema: "events-index/v1",
  updatedAt: "",
  entries: [],
};

export default async function Sp500Page() {
  const [entities, index] = await Promise.all([
    store.readRegistry(),
    store.readEventsIndex?.() ?? Promise.resolve(EMPTY_INDEX),
  ]);
  const members = entities.filter((e) => (e.index_membership ?? []).includes("SP500"));
  const memberTickers = new Set(members.map((m) => m.ticker));

  // latestMetrics unused by sector groupings; skip populating it.
  const allRows = buildWatchlistRowsFromIndex(
    entities,
    index.entries,
    todayIso(),
    { includeLatestMetrics: false },
  );
  const inIndex = allRows.filter((r) => memberTickers.has(r.ticker));

  // Group by industry group (real GICS-ish sub-industry, populated by
  // the daily cron from Yahoo assetProfile; Wikipedia's GICS
  // sub-industry seeds the value at registration). Unknown industry
  // → "(unclassified)" bucket sinks to the bottom.
  const byIndustry = new Map<string, typeof inIndex>();
  for (const r of inIndex) {
    const g = r.entity.industryGroup ?? "(unclassified)";
    if (!byIndustry.has(g)) byIndustry.set(g, []);
    byIndustry.get(g)!.push(r);
  }
  const groups = [...byIndustry.entries()]
    .map(([id, rows]) => ({
      id,
      rows: rows.slice().sort(
        (a, b) => (b.entity.marketCapUsd ?? 0) - (a.entity.marketCapUsd ?? 0),
      ),
    }))
    .sort((a, b) => {
      // Unclassified always last.
      if (a.id === "(unclassified)") return 1;
      if (b.id === "(unclassified)") return -1;
      // Otherwise sort by member count descending.
      return b.rows.length - a.rows.length;
    });

  // Estimate coverage counter for the acceptance report — how many
  // members carry at least one estimate (revenue OR EPS) on their
  // latest reported event. Reads events-index only (no shard reads).
  let withNextEvent = 0;
  let withPastEvent = 0;
  for (const r of inIndex) {
    if (r.nextEvent.date) withNextEvent++;
    if (r.lastPeriod) withPastEvent++;
  }

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-5">
        <Breadcrumb
          crumbs={[
            { label: "Overview", href: "/" },
            { label: "Sectors", href: "/sectors" },
            { label: "S&P 500" },
          ]}
        />
      </div>
      <div className="mb-6">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          S&amp;P 500 <span className="text-tx-mid text-[20px]">· index membership</span>
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13.5px] text-tx2">
          {members.length} constituents · {groups.length - (byIndustry.has("(unclassified)") ? 1 : 0)} industry groups · sourced from
          Wikipedia&apos;s List of S&amp;P 500 companies, reconciled on{" "}
          <code className="text-tx3">
            {/* Reference date lives on data/reference/sp500.json */}
            {new Date().toISOString().slice(0, 10)}
          </code>
          . Members keep their real GICS sectors and industry groups;
          this view groups by industry.
        </p>
        <p className="mt-2 font-mono text-[11px] text-tx3">
          coverage · {withPastEvent}/{members.length} have latest reported event ·{" "}
          {withNextEvent}/{members.length} have next-event date
        </p>
      </div>

      <SectorGroupsFilter groups={groups} totalRows={inIndex.length} />
    </div>
  );
}
