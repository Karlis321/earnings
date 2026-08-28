import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { IdeasTable } from "@/components/ideas/IdeasTable";

// Feature 3B — /ideas view.
// Renders data/ranking.json (Feature 3A) as a sortable, filterable
// table. Composite score + component values ride along so the user
// can defend any ranking by pointing at inputs, not a black box.

export const dynamic = "force-dynamic";

export default async function IdeasPage() {
  const [ranking, state] = await Promise.all([
    store.readRanking ? store.readRanking() : Promise.resolve(null),
    store.readSharedState(),
  ]);

  const focusTickers = state.preferences?.focusTickers ?? [];

  if (!ranking || ranking.rows.length === 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-10 py-20">
        <EmptyState
          title="No ranking snapshot yet"
          hint="Run `node scripts/run-ranking.mjs` locally, or wait for the daily refresh to fire the ranking phase."
        />
      </div>
    );
  }

  const genDate = ranking.generatedAt.slice(0, 10);
  const genTime = ranking.generatedAt.slice(11, 16);

  return (
    <div className="mx-auto max-w-[1400px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Ideas · Composite ranking</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {ranking.rows.length} names ranked · last {ranking.windowDays} days
        </h1>
        <p className="mt-2 max-w-[80ch] text-[13px] text-tx-mid">
          Mechanical composite over the SP500 ∪ R1000 ∪ portfolio.{" "}
          <span className="font-mono">
            composite = {ranking.weights.reaction.toFixed(2)} × reactionScore + {ranking.weights.surprise.toFixed(2)} × surpriseScore
          </span>
          . Each component is normalized to 0-1 against a cap
          (reaction |{Math.round(ranking.caps.reactionAbsReturn * 100)}%|, surprise |
          {ranking.caps.surpriseAbsPct}%|). Raw values shown alongside the score
          so you can trace any row back to its inputs. Not a
          recommendation — cross-check every idea.
        </p>
        <p className="mt-1 font-mono text-[10.5px] text-tx3">
          generated {genDate} {genTime}Z · universe {ranking.universeSize} candidates ·{" "}
          {ranking.filteredSplitArtifacts} split-artifact rows filtered
        </p>
      </div>
      <IdeasTable rows={ranking.rows} focusTickers={focusTickers} />
    </div>
  );
}
