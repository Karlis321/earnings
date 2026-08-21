import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { CorrelationHeatmap } from "@/components/correlation/CorrelationHeatmap";
import type { Entity } from "@/lib/types";

// Phase 4.1 — /correlation — pairwise return-correlation heatmap
// over the watchlist universe. Data is precomputed by
// scripts/refresh-correlations.mjs and read via the store; no
// per-visitor Yahoo calls.

export const dynamic = "force-dynamic";

interface EntityMeta {
  displayName: string;
  primarySector: string | null;
  tags: string[];
}

// Group tickers into pairs by absolute correlation — surfaces the
// "most redundant" pairs at a glance.
function topPairs(
  data: import("@/lib/types").Correlations,
  n: number,
): Array<{ a: string; b: string; r: number }> {
  const out: Array<{ a: string; b: string; r: number }> = [];
  const seen = new Set<string>();
  for (const a of data.tickers) {
    for (const b of data.tickers) {
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = data.matrix[a]?.[b];
      if (typeof r !== "number") continue;
      out.push({ a, b, r });
    }
  }
  out.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return out.slice(0, n);
}

// Two-tier tag classification:
//   STRUCTURAL — wrapper / geography labels. Never carry sector meaning
//                on their own (an ETF's "etf" tag says nothing about
//                the industry it tracks). Skip these when picking
//                primarySector or a shared theme between two tickers.
//   BUCKET     — broad industry buckets. Fine as a shared theme
//                (e.g. two miners share "mining") but a more specific
//                tag on the same entity ("copper") is preferred as
//                its primarySector.
// Anything not in either set is treated as a specific sector tag.
const STRUCTURAL_TAGS = new Set(["etf", "developer", "canada", "brazil"]);
const BUCKET_TAGS = new Set([
  "materials",
  "financial-services",
  "energy",
  "mining",
  "emerging-markets",
  "commodities",
]);

function metaFor(entity: Entity | undefined): EntityMeta {
  if (!entity) {
    return { displayName: "", primarySector: null, tags: [] };
  }
  const tags = Array.isArray(entity.sectorTags) ? entity.sectorTags : [];
  const specific = tags.find(
    (t) => !STRUCTURAL_TAGS.has(t) && !BUCKET_TAGS.has(t),
  );
  const bucket = tags.find((t) => BUCKET_TAGS.has(t));
  return {
    displayName: entity.displayName ?? "",
    primarySector: specific ?? bucket ?? null,
    tags,
  };
}

// Find the industry theme two tickers share, if any — so the pair
// row can say "both copper miners" rather than making the reader
// intersect two sector-tag lists in their head. Structural tags
// (etf, developer, canada, brazil) are ignored — two ETFs sharing
// "etf" isn't a meaningful theme.
function sharedTag(a: EntityMeta, b: EntityMeta): string | null {
  const setB = new Set(b.tags);
  // Prefer specific tags first; fall back to broad industry buckets.
  for (const t of a.tags) {
    if (STRUCTURAL_TAGS.has(t)) continue;
    if (BUCKET_TAGS.has(t)) continue;
    if (setB.has(t)) return t;
  }
  for (const t of a.tags) {
    if (STRUCTURAL_TAGS.has(t)) continue;
    if (setB.has(t)) return t;
  }
  return null;
}

function TagChip({ tag }: { tag: string }) {
  return (
    <span className="rounded-[3px] border border-bd bg-panel3/60 px-1 py-[1px] font-mono text-[9.5px] uppercase tracking-[0.06em] text-tx-mid">
      {tag}
    </span>
  );
}

function PairRow({
  p,
  metaA,
  metaB,
}: {
  p: { a: string; b: string; r: number };
  metaA: EntityMeta;
  metaB: EntityMeta;
}) {
  const shared = sharedTag(metaA, metaB);
  const positive = p.r >= 0;
  return (
    <div className="border-b border-bd/40 py-1.5 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">
          <span className="font-mono text-brand-fg">{p.a}</span>
          {metaA.displayName ? (
            <span className="ml-1.5 text-tx-mid">
              {metaA.displayName}
            </span>
          ) : null}
        </span>
        <span
          className={
            positive
              ? "shrink-0 font-mono text-[11.5px] text-success-fg"
              : "shrink-0 font-mono text-[11.5px] text-danger"
          }
          title={`Pearson correlation of daily log returns over 6mo — sign indicates direction, magnitude indicates strength (1 = perfect co-move, 0 = independent, −1 = perfect anti-move)`}
        >
          ρ {p.r >= 0 ? "+" : ""}
          {p.r.toFixed(2)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">
          <span className="font-mono text-brand-fg">{p.b}</span>
          {metaB.displayName ? (
            <span className="ml-1.5 text-tx-mid">
              {metaB.displayName}
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {shared ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-tx-mid">
            both →
          </span>
        ) : null}
        {shared ? <TagChip tag={shared} /> : null}
        {!shared ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-tx3">
            no shared theme
          </span>
        ) : null}
        {metaA.primarySector && !shared ? (
          <TagChip tag={`${p.a.split(" ")[0]}: ${metaA.primarySector}`} />
        ) : null}
        {metaB.primarySector && !shared ? (
          <TagChip tag={`${p.b.split(" ")[0]}: ${metaB.primarySector}`} />
        ) : null}
      </div>
    </div>
  );
}

export default async function CorrelationPage() {
  const [data, entities] = await Promise.all([
    store.readCorrelations ? store.readCorrelations() : Promise.resolve(null),
    store.readRegistry(),
  ]);

  if (!data) {
    return (
      <div className="mx-auto max-w-[1200px] px-10 py-20">
        <EmptyState
          title="No correlation snapshot yet"
          hint={
            "Run scripts/refresh-correlations.mjs to populate data/correlations.json. " +
            "This is a manual refresh for now — no cron phase — call it before checking the page."
          }
        />
      </div>
    );
  }

  const byTicker = new Map(entities.map((e) => [e.ticker, e]));
  const meta: Record<string, EntityMeta> = {};
  for (const t of data.tickers) meta[t] = metaFor(byTicker.get(t));

  const generatedDate = data.generatedAt.slice(0, 10);
  const topRedundant = topPairs(data, 5);
  const mostDivergent = [...topPairs(data, data.tickers.length ** 2)]
    .filter((p) => p.r < 0)
    .slice(0, 5);

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Correlation · Portfolio</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          Pairwise return correlation ·{" "}
          <span className="font-mono text-[22px] text-tx-mid">
            {data.tickers.length} × {data.tickers.length}
          </span>
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">
          Pearson correlation of daily log returns over{" "}
          <span className="font-mono">{data.range}</span>. Cells shade
          red → neutral → green from −1 to +1 (1 = perfect co-move, 0 =
          independent, −1 = perfect anti-move). Pairs sharing fewer than{" "}
          {data.minSharedBars} trading days render as{" "}
          <span className="font-mono">—</span> (typical when a listing has
          been live &lt; 3 months). Last refresh: {generatedDate}.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-[8px] border border-bd bg-panel2/40 px-3 py-2">
          <div className="mono-eyebrow mb-1 text-tx3">§ Most redundant</div>
          <p className="mb-2 text-[11.5px] text-tx-mid">
            Move together — owning both adds bulk, not diversification.
          </p>
          {topRedundant.length === 0 ? (
            <span className="text-tx3">no pairs</span>
          ) : (
            topRedundant.map((p, i) => (
              <PairRow
                key={`${p.a}|${p.b}|${i}`}
                p={p}
                metaA={meta[p.a]}
                metaB={meta[p.b]}
              />
            ))
          )}
        </div>
        <div className="rounded-[8px] border border-bd bg-panel2/40 px-3 py-2">
          <div className="mono-eyebrow mb-1 text-tx3">§ Most divergent</div>
          <p className="mb-2 text-[11.5px] text-tx-mid">
            Move opposite — hedge each other in the portfolio.
          </p>
          {mostDivergent.length === 0 ? (
            <span className="text-tx3">no negative-corr pairs</span>
          ) : (
            mostDivergent.map((p, i) => (
              <PairRow
                key={`${p.a}|${p.b}|${i}`}
                p={p}
                metaA={meta[p.a]}
                metaB={meta[p.b]}
              />
            ))
          )}
        </div>
      </div>

      <CorrelationHeatmap data={data} entityMeta={meta} />
    </div>
  );
}
