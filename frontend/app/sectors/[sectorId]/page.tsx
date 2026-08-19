import { store } from "@/server/store";
import { entitiesInSector } from "@/server/lib/registryHelpers";
import { buildWatchlistRowsFromIndex } from "@/lib/watchlist";
import { todayIso } from "@/lib/freshness";
import { notFound } from "next/navigation";
import { Panel } from "@/components/primitives";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import { SectorMemberRows } from "@/components/sectors/SectorMemberRows";
import { AlertOctagon } from "lucide-react";
import type { EventsIndex } from "@/lib/types";

interface Props {
  params: Promise<{ sectorId: string }>;
}

export const dynamic = "force-dynamic";

const EMPTY_INDEX: EventsIndex = {
  schema: "events-index/v1",
  updatedAt: "",
  entries: [],
};

export default async function SectorDetailPage({ params }: Props) {
  const { sectorId: raw } = await params;
  const sectorId = decodeURIComponent(raw);
  const [entities, index] = await Promise.all([
    store.readRegistry(),
    store.readEventsIndex?.() ?? Promise.resolve(EMPTY_INDEX),
  ]);
  const members = entitiesInSector(entities, sectorId);
  if (members.length === 0) notFound();

  // Sector detail renders SectorMemberRows which doesn't read
  // latestMetrics — skip populating it (saves ~1 MB on wide sectors
  // like technology/financials).
  const allRows = buildWatchlistRowsFromIndex(
    entities,
    index.entries,
    todayIso(),
    { includeLatestMetrics: false },
  );
  const inSector = allRows.filter((r) =>
    members.some((m) => m.ticker === r.ticker),
  );
  const portfolio = inSector.filter((r) => r.entity.isCore);
  // Universe = sector members that are NOT in the portfolio, restricted
  // to SP500 or R1000 constituents. Per-user directive (2026-08-19):
  // sector views should only surface names in the two big US indexes;
  // small caps / foreign / obscure listings clutter the grid without
  // matching how the user browses (index-first).
  const universe = inSector
    .filter((r) => !r.entity.isCore)
    .filter((r) => {
      const mem = r.entity.index_membership ?? [];
      return mem.includes("SP500") || mem.includes("R1000");
    })
    .sort(
      (a, b) => (b.entity.marketCapUsd ?? 0) - (a.entity.marketCapUsd ?? 0),
    );

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-5">
        <Breadcrumb
          crumbs={[
            { label: "Overview", href: "/" },
            { label: "Sectors", href: "/sectors" },
            { label: sectorId },
          ]}
        />
      </div>
      <div className="mb-6">
        <h1 className="text-[28px] font-semibold capitalize tracking-[-0.02em]">
          {sectorId}
        </h1>
        <p className="mt-1 text-[13.5px] text-tx-mid">
          {portfolio.length} portfolio · {universe.length} universe ·{" "}
          {portfolio.length + universe.length} total (SP500 ∪ R1000)
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          {portfolio.length > 0 ? (
            <Panel eyebrow={`Portfolio · ${portfolio.length}`} padded={false}>
              <SectorMemberRows rows={portfolio} />
            </Panel>
          ) : null}

          {universe.length > 0 ? (
            <Panel
              eyebrow={`Universe · ${universe.length} · sorted by market cap`}
              padded={false}
            >
              <details open>
                <summary className="cursor-pointer border-b border-bd px-4 py-3 text-[12.5px] text-tx-mid hover:bg-hover hover:text-tx">
                  {universe.length} universe entities · click to collapse
                </summary>
                <SectorMemberRows rows={universe} />
              </details>
            </Panel>
          ) : null}

          {portfolio.length === 0 && universe.length === 0 ? (
            <Panel eyebrow="No members">
              <div className="text-[13px] text-tx-mid">
                No covered names tagged with <code>{sectorId}</code>.
              </div>
            </Panel>
          ) : null}
        </div>

        <Panel eyebrow="Sector read · LLM enrichment">
          <div className="flex flex-col items-start gap-3 rounded-panel border border-dashed border-bd bg-panel2 p-5 text-tx-mid">
            <div className="flex items-center gap-2 text-warning">
              <AlertOctagon size={14} />
              <span className="mono-eyebrow normal-case tracking-normal">
                LLM enrichment · disabled in $0 mode
              </span>
            </div>
            <p className="text-[13px] leading-[1.6]">
              The vibe/forward summary is powered by Claude Haiku. It is
              switched off in this build to stay at $0 operating cost. Enable
              it in Settings when a monthly ceiling is agreed.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
