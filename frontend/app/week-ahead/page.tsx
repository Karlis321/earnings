import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { MarketPulse } from "@/components/overview/MarketPulse";
import { WeekAheadGrid } from "@/components/week-ahead/WeekAheadGrid";
import { MacroStrip } from "@/components/week-ahead/MacroStrip";
import { NarrativePanel } from "@/components/week-ahead/NarrativePanel";
import { isDisplayable } from "@/lib/displayFilter";
import { todayIso } from "@/lib/freshness";
import type { WeekAheadRow } from "@/components/week-ahead/WeekAheadGrid";

// Feature 2A/2B/2D — Week Ahead view.
// Aggregates upcoming events across the SP500 ∪ R1000 ∪ isCore
// universe with nextScheduled in the next 7 days. Rows are enriched
// with the ticker's ranking data (composite score, components) when
// present. Focus tickers from user preferences render at the top of
// each day. Market Pulse index strip renders above for context.

export const dynamic = "force-dynamic";

// Number of days forward — 7 covers a full trading week.
const HORIZON_DAYS = 7;

function isoAfterDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Props {
  searchParams: Promise<{ ticker?: string }>;
}

export default async function WeekAheadPage({ searchParams }: Props) {
  const sp = await searchParams;
  const highlightTicker = sp.ticker ?? null;
  const [entities, index, state, ranking, macro, narrative] = await Promise.all([
    store.readRegistry(),
    store.readEventsIndex?.() ??
      Promise.resolve({ schema: "events-index/v1", updatedAt: "", entries: [] }),
    store.readSharedState(),
    store.readRanking ? store.readRanking() : Promise.resolve(null),
    store.readMacroSignals ? store.readMacroSignals() : Promise.resolve(null),
    store.readWeekAheadNarrative
      ? store.readWeekAheadNarrative()
      : Promise.resolve(null),
  ]);

  const today = todayIso();
  const horizonEnd = isoAfterDays(HORIZON_DAYS);
  const focusTickers = new Set(state.preferences?.focusTickers ?? []);

  const byTicker = new Map(entities.map((e) => [e.ticker, e]));
  const rankingByTicker = new Map(
    (ranking?.rows ?? []).map((r) => [r.ticker, r]),
  );

  // Universe = displayable operating entities from SP500 / R1000 /
  // isCore — matches the /ideas leaderboard scope so the two views
  // are comparable. Exclude foreign + pre-listing entities.
  const rows: WeekAheadRow[] = [];
  for (const entry of index.entries) {
    if (!entry.nextScheduled) continue;
    if (entry.nextScheduled < today || entry.nextScheduled > horizonEnd) continue;
    const ent = byTicker.get(entry.ticker);
    if (!ent) continue;
    if (!isDisplayable(ent)) continue;
    if (ent.securityType !== "operating") continue;
    const mem = ent.index_membership ?? [];
    if (!ent.isCore && !mem.includes("SP500") && !mem.includes("R1000")) continue;
    const r = rankingByTicker.get(entry.ticker);
    rows.push({
      ticker: entry.ticker,
      displayName: ent.displayName,
      capTier: ent.capTier ?? "unknown",
      marketCapUsd: ent.marketCapUsd ?? null,
      period: entry.nextPeriod ?? "—",
      scheduledDate: entry.nextScheduled,
      isEstimated: !!entry.nextIsEstimated,
      cadence: entry.nextCadence,
      lastPeriod: entry.lastPeriod ?? null,
      lastSurprisePct: entry.lastSurprisePct ?? null,
      compositeScore: r?.compositeScore ?? null,
      compositeRank: r?.rank ?? null,
      isFocus: focusTickers.has(entry.ticker),
    });
  }

  if (rows.length === 0) {
    return (
      <div className="mx-auto max-w-[1200px] px-10 py-20">
        <EmptyState
          title="No upcoming events in the next 7 days"
          hint="This is unusual for the covered universe — check that events-index.json is fresh (last refresh phase should have run within 24h)."
        />
      </div>
    );
  }

  const focusCount = rows.filter((r) => r.isFocus).length;

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <MarketPulse />
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Week Ahead · Next 7 days</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {rows.length} earnings events scheduled · {today} → {horizonEnd}
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">
          Universe: SP500 ∪ R1000 ∪ portfolio, operating names only.
          Ranking (composite + rank) enriches each row when available;
          rows without a ranking match still render with the ticker +
          period + last-surprise context.
        </p>
        {focusCount > 0 ? (
          <p className="mt-1 font-mono text-[11px] text-brand-fg">
            {focusCount} of your focus tickers report this week — highlighted at the top of each day.
          </p>
        ) : null}
      </div>

      {narrative ? (
        <NarrativePanel narrative={narrative} />
      ) : (
        <div className="mb-4 rounded-[8px] border border-dashed border-bd bg-panel2/40 px-4 py-3 text-[12px] text-tx-mid">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.07em] text-tx3">
            § Narrative
          </span>{" "}
          — no snapshot yet. The{" "}
          <code className="text-tx-mid">week-ahead</code> workflow fires
          Sunday 22:00 UTC and writes The setup + What to watch + Signals
          to trust sections based on the ranking + macro + market-pulse
          state. Day grid below still renders from events-index directly.
        </div>
      )}

      {macro && macro.signals.length > 0 ? (
        <MacroStrip signals={macro} />
      ) : null}

      <WeekAheadGrid
        rows={rows}
        horizonStart={today}
        horizonEnd={horizonEnd}
        highlightTicker={highlightTicker}
      />
    </div>
  );
}
