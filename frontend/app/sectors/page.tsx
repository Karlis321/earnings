import Link from "next/link";
import { store } from "@/server/store";
import { sectorCounts } from "@/server/lib/registryHelpers";
import { Panel } from "@/components/primitives";

// force-dynamic + store's 60s read cache = counts stay live within a
// minute of any registry write (POST /api/entity-registry, DELETE, or
// the daily cron's sector-universe refresh).
export const dynamic = "force-dynamic";

export default async function SectorsPage() {
  const entities = await store.readRegistry();
  const sectors = sectorCounts(entities);
  const totalCore = entities.filter((e) => e.isCore).length;
  const totalUniverse = entities.length - totalCore;
  const totalEquities = entities.filter((e) => e.securityType !== "etf").length;
  const totalEtfs = entities.length - totalEquities;

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Sectors</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          Sector view
        </h1>
        <p className="mt-2 max-w-[64ch] text-[13.5px] text-tx2">
          Thematic grouping across covered names. {entities.length} total
          entities · {totalEquities} equities · {totalEtfs} ETFs ·{" "}
          {totalCore} portfolio · {totalUniverse} sector universe across{" "}
          {sectors.length} tags. Auto-refreshes on the daily cron (sector
          expansion + market-cap pass).
        </p>
      </div>

      <Panel eyebrow="Sectors · from registry sectorTags" padded={false}>
        <div className="grid grid-cols-1 divide-y divide-bd md:grid-cols-2 md:divide-y-0 md:divide-x">
          {sectors.map((s) => (
            <Link
              key={s.id}
              href={`/sectors/${encodeURIComponent(s.id)}`}
              className="flex items-center justify-between px-5 py-4 hover:bg-hover"
            >
              <div>
                <div className="text-[14px] text-tx capitalize">{s.id}</div>
                <div className="mt-1 flex items-baseline gap-2 font-mono text-[11px] text-tx3">
                  <span>
                    {s.count} name{s.count === 1 ? "" : "s"}
                  </span>
                  {s.equities > 0 ? (
                    <span className="text-tx-mid">
                      · {s.equities} equit{s.equities === 1 ? "y" : "ies"}
                    </span>
                  ) : null}
                  {s.etfs > 0 ? (
                    <span className="text-tx-mid">· {s.etfs} ETF{s.etfs === 1 ? "" : "s"}</span>
                  ) : null}
                  {s.portfolio > 0 ? (
                    <span className="text-brand-fg">
                      · {s.portfolio} portfolio
                    </span>
                  ) : null}
                </div>
              </div>
              <span className="text-tx3">→</span>
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}
