import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { ThemesView } from "@/components/themes/ThemesView";

// /themes — server shell that fetches sector-signals + sector-ideas
// and hands both to the client ThemesView. All rendering + the
// family-filter interactivity live in the client component.

export const dynamic = "force-dynamic";

export default async function ThemesPage() {
  const [data, ideas] = await Promise.all([
    store.readSectorSignals
      ? store.readSectorSignals()
      : Promise.resolve(null),
    store.readSectorIdeas
      ? store.readSectorIdeas()
      : Promise.resolve(null),
  ]);

  if (!data) {
    return (
      <div className="mx-auto max-w-[1200px] px-10 py-20">
        <EmptyState
          title="No sector rollup yet"
          hint="Run scripts/aggregate-by-sector.mjs to populate data/sector-signals.json. Mechanical (no LLM, no vendor calls) — takes ~1 min."
        />
      </div>
    );
  }

  const generatedDate = data.generatedAt.slice(0, 10);
  return (
    <div className="mx-auto max-w-[1400px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Themes</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {ideas ? `${ideas.themes.length} AI themes · ` : ""}
          {data.sectors.length} sectors mechanically rolled up
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">
          Two layers: an LLM-drafted panel of narrative themes at the
          top (weekly refresh, every claim grounded in the mechanical
          layer below), followed by the full sector grid ranked by
          |median 3-day reaction|. Each ticker in the tracked universe
          contributes to every sector tag it carries. Sectors with
          fewer than {data.minTickersPerSector} tickers drop off.
          Filter by family below to focus on one industry area at a
          time. Sector data refreshed {generatedDate}.
        </p>
      </div>

      <ThemesView data={data} ideas={ideas} />
    </div>
  );
}
