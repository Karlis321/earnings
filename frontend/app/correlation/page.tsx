import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { CorrelationHeatmap } from "@/components/correlation/CorrelationHeatmap";

// Phase 4.1 — /correlation — pairwise return-correlation heatmap
// over the watchlist universe. Data is precomputed by
// scripts/refresh-correlations.mjs and read via the store; no
// per-visitor Yahoo calls.

export const dynamic = "force-dynamic";

// Group tickers into pairs by absolute correlation ≥ threshold —
// surfaces the "most redundant" pairs at a glance.
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

export default async function CorrelationPage() {
  const data = store.readCorrelations ? await store.readCorrelations() : null;

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
          red → neutral → green from −1 to +1. Pairs sharing fewer than{" "}
          {data.minSharedBars} trading days render as{" "}
          <span className="font-mono">—</span> (typical when a listing has
          been live &lt; 3 months). Last refresh: {generatedDate}.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-[8px] border border-bd bg-panel2/40 px-3 py-2">
          <div className="mono-eyebrow mb-1 text-tx3">§ Most redundant</div>
          <div className="space-y-0.5 text-[12px]">
            {topRedundant.length === 0 ? (
              <span className="text-tx3">no pairs</span>
            ) : (
              topRedundant.map((p, i) => (
                <div
                  key={`${p.a}|${p.b}|${i}`}
                  className="flex items-baseline gap-2"
                >
                  <span className="font-mono text-brand-fg">{p.a}</span>
                  <span className="text-tx3">×</span>
                  <span className="font-mono text-brand-fg">{p.b}</span>
                  <span
                    className={
                      p.r >= 0
                        ? "ml-auto font-mono text-success-fg"
                        : "ml-auto font-mono text-danger"
                    }
                  >
                    ρ {p.r.toFixed(2)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="rounded-[8px] border border-bd bg-panel2/40 px-3 py-2">
          <div className="mono-eyebrow mb-1 text-tx3">§ Most divergent</div>
          <div className="space-y-0.5 text-[12px]">
            {mostDivergent.length === 0 ? (
              <span className="text-tx3">no negative-corr pairs</span>
            ) : (
              mostDivergent.map((p, i) => (
                <div
                  key={`${p.a}|${p.b}|${i}`}
                  className="flex items-baseline gap-2"
                >
                  <span className="font-mono text-brand-fg">{p.a}</span>
                  <span className="text-tx3">×</span>
                  <span className="font-mono text-brand-fg">{p.b}</span>
                  <span className="ml-auto font-mono text-danger">
                    ρ {p.r.toFixed(2)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <CorrelationHeatmap data={data} />
    </div>
  );
}
