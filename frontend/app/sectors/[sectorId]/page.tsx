import Link from "next/link";
import { store } from "@/server/store";
import { entitiesInSector } from "@/server/lib/registryHelpers";
import { buildWatchlistRows } from "@/lib/watchlist";
import { TODAY_ISO } from "@/lib/freshness";
import { notFound } from "next/navigation";
import {
  Panel,
  TypeBadge,
  FreshnessDot,
  SurprisePill,
} from "@/components/primitives";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import { fmtDateShort } from "@/lib/format";
import { AlertOctagon } from "lucide-react";

interface Props {
  params: Promise<{ sectorId: string }>;
}

export const dynamic = "force-dynamic";

export default async function SectorDetailPage({ params }: Props) {
  const { sectorId: raw } = await params;
  const sectorId = decodeURIComponent(raw);
  const [entities, snapshot] = await Promise.all([
    store.readRegistry(),
    store.readEarnings(),
  ]);
  const members = entitiesInSector(entities, sectorId);
  if (members.length === 0) notFound();

  const allRows = buildWatchlistRows(entities, snapshot, TODAY_ISO);
  const watchlist = allRows.filter((r) =>
    members.some((m) => m.ticker === r.ticker),
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
          {members.length} covered name{members.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel eyebrow="Members" padded={false}>
          {watchlist.map((r) => (
            <Link
              key={r.ticker}
              href={`/s/${encodeURIComponent(r.ticker)}`}
              className="grid grid-cols-[1.5fr_1fr_1fr_auto] items-center gap-3 border-b border-bd px-4 py-3 last:border-b-0 hover:bg-hover"
            >
              <span className="flex items-center gap-2">
                <TypeBadge type={r.entity.securityType} size="sm" />
                <span className="text-[13.5px] text-tx">
                  {r.entity.displayName}
                </span>
                <span className="font-mono text-[11px] text-tx-mid">
                  {r.ticker}
                </span>
              </span>
              <span className="font-mono text-[12.5px] text-tx-mid">
                {r.nextEvent.date ? fmtDateShort(r.nextEvent.date) : "—"}
              </span>
              <span>
                {r.entity.securityType === "operating" && r.lastSurprisePct !== null ? (
                  <SurprisePill surprisePct={r.lastSurprisePct} compact />
                ) : (
                  <span className="text-[12.5px] text-tx3">—</span>
                )}
              </span>
              <FreshnessDot state={r.freshness} />
            </Link>
          ))}
        </Panel>

        <Panel eyebrow="Sector read · LLM enrichment">
          <div className="flex flex-col items-start gap-3 rounded-panel border border-dashed border-bd bg-panel2 p-5 text-tx-mid">
            <div className="flex items-center gap-2 text-warning">
              <AlertOctagon size={14} />
              <span className="mono-eyebrow normal-case tracking-normal">
                LLM enrichment · disabled in $0 mode
              </span>
            </div>
            <p className="text-[13px] leading-[1.6]">
              The vibe/forward summary is powered by Claude Haiku. It is switched
              off in this build to stay at $0 operating cost. Enable it in
              Settings when a monthly ceiling is agreed.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
