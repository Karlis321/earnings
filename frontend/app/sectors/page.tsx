import Link from "next/link";
import { store } from "@/server/store";
import { sectorCounts } from "@/server/lib/registryHelpers";
import { Panel } from "@/components/primitives";
import { isDisplayable } from "@/lib/displayFilter";

// force-dynamic + store's 60s read cache = counts stay live within a
// minute of any registry write (POST /api/entity-registry, DELETE, or
// the daily cron's sector-universe refresh).
export const dynamic = "force-dynamic";

export default async function SectorsPage() {
  const entities = await store.readRegistry();
  // ETF/fund entities live in the registry to power benchmarks but
  // never render on this surface — see displayFilter.ts.
  const displayable = entities.filter(isDisplayable);
  const sectors = sectorCounts(entities);
  const totalCore = displayable.filter((e) => e.isCore).length;
  const totalUniverse = displayable.length - totalCore;
  const totalEquities = displayable.length;

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Sectors</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          Sector view
        </h1>
        <p className="mt-2 max-w-[64ch] text-[13.5px] text-tx2">
          Thematic grouping across covered names. {totalEquities} equities ·{" "}
          {totalCore} portfolio · {totalUniverse} sector universe across{" "}
          {sectors.length} tags. Auto-refreshes on the daily cron (sector
          expansion + market-cap pass).
        </p>
      </div>

      <Panel eyebrow="Index membership" padded={false}>
        <div className="divide-y divide-bd">
          <Link
            href="/sectors/sp500"
            className="flex items-center justify-between px-5 py-4 hover:bg-hover"
          >
            <div>
              <div className="text-[14px] text-tx">S&amp;P 500</div>
              <div className="mt-1 font-mono text-[11px] text-tx3">
                {displayable.filter((e) => (e.index_membership ?? []).includes("SP500")).length}{" "}
                constituents · grouped by real industry group
              </div>
            </div>
            <span className="text-tx3">→</span>
          </Link>
          <Link
            href="/sectors/russell1000"
            className="flex items-center justify-between px-5 py-4 hover:bg-hover"
          >
            <div>
              <div className="text-[14px] text-tx">Russell 1000</div>
              <div className="mt-1 font-mono text-[11px] text-tx3">
                {displayable.filter((e) => (e.index_membership ?? []).includes("R1000")).length}{" "}
                constituents · superset of S&amp;P 500, top ~1,000 US caps
              </div>
            </div>
            <span className="text-tx3">→</span>
          </Link>
        </div>
      </Panel>

      <div className="h-4" />

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
