import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { IdeasTable } from "@/components/ideas/IdeasTable";
import { IdeasPitchStrip } from "@/components/ideas/IdeasPitchStrip";

// Feature 3B/3C — Ideas view.
//   3B: sortable leaderboard from data/ranking.json (Feature 3A).
//   3C: AI pitch cards from data/ideas.json, rendered as a strip
//       above the leaderboard when present. Absent → strip omitted,
//       leaderboard is the whole page.

export const dynamic = "force-dynamic";

export default async function IdeasPage() {
  const [ranking, ideas] = await Promise.all([
    store.readRanking ? store.readRanking() : Promise.resolve(null),
    store.readIdeas ? store.readIdeas() : Promise.resolve(null),
  ]);

  if (!ranking) {
    return (
      <div className="mx-auto max-w-[1200px] px-10 py-20">
        <EmptyState
          title="No ranking snapshot yet"
          hint="Run node scripts/run-ranking.mjs to produce data/ranking.json — the daily refresh will schedule this automatically once wired in."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Ideas · Signal ranking</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {ranking.stats.scored} scored names · composite of reaction + surprise + trend
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">
          Universe: <code className="text-tx3">{ranking.universe}</code>. Each
          row&apos;s composite score is a tanh-scaled mean over the three
          components its data supports. Missing components re-normalize the
          weights — no zero-imputation.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-tx3">
          <span>coverage · reaction {ranking.stats.hasReaction} · surprise {ranking.stats.hasSurprise} · trend {ranking.stats.hasTrend}</span>
          <span>all three: {ranking.stats.hasAllThree}</span>
          <span>generated {ranking.generatedAt.slice(0, 16).replace("T", " ")}Z</span>
        </div>
      </div>

      {ideas && ideas.pitches.length > 0 ? (
        <IdeasPitchStrip ideas={ideas} />
      ) : null}

      <IdeasTable ranking={ranking} />
    </div>
  );
}
