import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { ThemesView } from "@/components/themes/ThemesView";
import type {
  SectorHistoryRow,
  SectorSignals,
} from "@/lib/types";

// /themes — server shell that fetches sector-signals + sector-ideas
// and hands both to the client ThemesView. All rendering + the
// family-filter interactivity live in the client component.

export const dynamic = "force-dynamic";

// For each sector in today's snapshot, find the reference reaction
// value from ~7 days ago (any history row 5-14 days old works; we
// take the CLOSEST to 7 days back). Returns a map sector → prior
// reaction number. Sectors without a prior row are absent from the
// map and the UI silently skips the delta chip for them.
function buildPriorReactionMap(
  data: SectorSignals,
  history: SectorHistoryRow[],
): Record<string, number> {
  const todayIso = (data.generatedAt ?? "").slice(0, 10);
  if (!todayIso) return {};
  const todayMs = new Date(todayIso + "T00:00:00Z").getTime();
  const MIN_MS = 5 * 86_400_000;
  const MAX_MS = 14 * 86_400_000;

  // Group history rows per sector
  const bySector = new Map<string, SectorHistoryRow[]>();
  for (const r of history) {
    if (r.medianReaction3d == null) continue;
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector)!.push(r);
  }

  const out: Record<string, number> = {};
  for (const s of data.sectors) {
    const rows = bySector.get(s.sector);
    if (!rows) continue;
    // Pick the row closest to 7 days back within [5, 14].
    let best: SectorHistoryRow | null = null;
    let bestDelta = Infinity;
    for (const r of rows) {
      const rowMs = new Date(r.date + "T00:00:00Z").getTime();
      const ageMs = todayMs - rowMs;
      if (ageMs < MIN_MS || ageMs > MAX_MS) continue;
      const d = Math.abs(ageMs - 7 * 86_400_000);
      if (d < bestDelta) {
        bestDelta = d;
        best = r;
      }
    }
    if (best && best.medianReaction3d != null) {
      out[s.sector] = best.medianReaction3d;
    }
  }
  return out;
}

export default async function ThemesPage() {
  const [data, ideas, history] = await Promise.all([
    store.readSectorSignals
      ? store.readSectorSignals()
      : Promise.resolve(null),
    store.readSectorIdeas
      ? store.readSectorIdeas()
      : Promise.resolve(null),
    store.readSectorHistory
      ? store.readSectorHistory()
      : Promise.resolve([]),
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

      <ThemesView
        data={data}
        ideas={ideas}
        priorReactionBySector={buildPriorReactionMap(data, history)}
      />
    </div>
  );
}
