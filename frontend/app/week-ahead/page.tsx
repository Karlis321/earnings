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
  searchParams: Promise<{ ticker?: string; week?: string }>;
}

export default async function WeekAheadPage({ searchParams }: Props) {
  const sp = await searchParams;
  const highlightTicker = sp.ticker ?? null;
  const archivedWeek =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : null;
  const [entities, index, state, ranking, macro, currentNarrative, archiveWeeks, archivedNarrative] =
    await Promise.all([
      store.readRegistry(),
      store.readEventsIndex?.() ??
        Promise.resolve({ schema: "events-index/v1", updatedAt: "", entries: [] }),
      store.readSharedState(),
      store.readRanking ? store.readRanking() : Promise.resolve(null),
      store.readMacroSignals ? store.readMacroSignals() : Promise.resolve(null),
      store.readWeekAheadNarrative
        ? store.readWeekAheadNarrative()
        : Promise.resolve(null),
      store.listWeekAheadArchive
        ? store.listWeekAheadArchive()
        : Promise.resolve([]),
      archivedWeek && store.readWeekAheadArchive
        ? store.readWeekAheadArchive(archivedWeek)
        : Promise.resolve(null),
    ]);
  const narrative = archivedWeek ? archivedNarrative : currentNarrative;

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

      {archivedWeek ? (
        <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-brand/40 bg-brand/8 px-3 py-2 text-[12px] text-tx-hi">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.07em] text-brand-fg">
            § Archived
          </span>
          <span>
            Viewing archived narrative for week of{" "}
            <span className="font-mono">{archivedWeek}</span>.
          </span>
          <a
            href="/week-ahead"
            className="ml-auto font-mono text-[11px] text-brand-fg underline decoration-dotted underline-offset-2 hover:text-brand"
          >
            → back to current
          </a>
        </div>
      ) : null}

      {narrative ? (
        <NarrativePanel narrative={narrative} />
      ) : (
        <div className="mb-4 rounded-[8px] border border-dashed border-bd bg-panel2/40 px-4 py-3 text-[12px] text-tx-mid">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.07em] text-tx3">
            § Narrative
          </span>{" "}
          — no snapshot yet
          {archivedWeek ? ` for week ${archivedWeek}` : ""}. The{" "}
          <code className="text-tx-mid">week-ahead</code> workflow fires
          Sunday 22:00 UTC and writes The setup + What to watch + Signals
          to trust sections based on the ranking + macro + market-pulse
          state. Day grid below still renders from events-index directly.
        </div>
      )}

      {archiveWeeks.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px] text-tx-mid">
          <span className="font-mono uppercase tracking-[0.07em] text-tx3">
            § Past weeks
          </span>
          {archiveWeeks.slice(0, 12).map((w) => {
            const active = archivedWeek === w;
            return (
              <a
                key={w}
                href={active ? "/week-ahead" : `/week-ahead?week=${w}`}
                className={
                  active
                    ? "rounded-[4px] border border-brand/40 bg-brand/10 px-1.5 py-[2px] font-mono text-[10.5px] text-brand-fg"
                    : "rounded-[4px] border border-bd px-1.5 py-[2px] font-mono text-[10.5px] text-tx-mid hover:border-brand/40 hover:text-brand-fg"
                }
              >
                {w}
              </a>
            );
          })}
        </div>
      ) : null}

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
