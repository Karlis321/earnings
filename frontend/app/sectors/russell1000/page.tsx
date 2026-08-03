// Russell 1000 grouping view. Same shape as /sectors/sp500 —
// filters by entity.index_membership.includes("R1000") and
// sub-groups by real industryGroup. Companion to /sectors/sp500.

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

export default async function Russell1000Page() {
  const [entities, index] = await Promise.all([
    store.readRegistry(),
    store.readEventsIndex?.() ?? Promise.resolve(EMPTY_INDEX),
  ]);
  const members = entities.filter((e) => (e.index_membership ?? []).includes("R1000"));
  const memberTickers = new Set(members.map((m) => m.ticker));

  const allRows = buildWatchlistRowsFromIndex(entities, index.entries, todayIso());
  const inIndex = allRows.filter((r) => memberTickers.has(r.ticker));

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
      if (a.id === "(unclassified)") return 1;
      if (b.id === "(unclassified)") return -1;
      return b.rows.length - a.rows.length;
    });

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
            { label: "Russell 1000" },
          ]}
        />
      </div>
      <div className="mb-6">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          Russell 1000 <span className="text-tx-mid text-[20px]">· index membership</span>
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13.5px] text-tx2">
          {members.length} constituents ·{" "}
          {groups.length - (byIndustry.has("(unclassified)") ? 1 : 0)} industry
          groups · sourced from Wikipedia&apos;s Russell 1000 constituents,
          reconciled on{" "}
          <code className="text-tx3">
            {new Date().toISOString().slice(0, 10)}
          </code>
          . Superset of S&amp;P 500 (top 1,000 US caps by market cap; ~93%
          of total US market value).
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
