"use client";

// Ideas table — sortable leaderboard for data/ranking.json.
// Sort modes: composite (default) / reaction / surprise / trend.
// Coverage filter: min-components toggle (any / ≥2 / all 3).
// Rows link to the ticker detail page.
// Per-row ★ toggle mutates preferences.focusTickers via a PUT to
// /api/shared-state — same commit-pipe path as FocusToggle on the
// ticker detail page, so multiple concurrent writes converge via
// the shared-state 3-retry 409 handling.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowUp, ArrowDown, Minus, Star, StarOff } from "lucide-react";
import type {
  Ranking,
  RankingRow,
  RankingComponent,
  SharedState,
} from "@/lib/types";
import { TickerLogo } from "@/components/primitives/TickerLogo";

type SortKey = "composite" | "reaction" | "surprise" | "trend";
type MinComponents = 1 | 2 | 3;

const SORT_LABEL: Record<SortKey, string> = {
  composite: "Composite",
  reaction: "Reaction (d3)",
  surprise: "Surprise",
  trend: "Trend",
};

const CAP_LABEL: Record<string, string> = {
  mega: "Mega",
  large: "Large",
  mid: "Mid",
  small: "Small",
  unknown: "—",
};

function sortValue(r: RankingRow, k: SortKey): number {
  if (k === "composite") return r.compositeScore;
  const c = r.components[k];
  return c?.score ?? -Infinity;
}

function ComponentCell({ c }: { c: RankingComponent | null }) {
  if (!c) {
    return <span className="text-tx3">—</span>;
  }
  const isUp = c.raw > 0;
  const isFlat = Math.abs(c.raw) < 0.05;
  const Icon = isFlat ? Minus : isUp ? ArrowUp : ArrowDown;
  const color = isFlat
    ? "text-tx-mid"
    : isUp
    ? "text-success-fg"
    : "text-danger";
  return (
    <span className="inline-flex items-center gap-[3px] tabular-nums">
      <Icon aria-hidden className={clsx("h-[10px] w-[10px]", color)} />
      <span className={clsx("font-mono text-[11.5px]", color)}>
        {c.raw >= 0 ? "+" : ""}
        {c.raw.toFixed(1)}%
      </span>
    </span>
  );
}

// Composite gets its own bar-style rendering so the eye lands there first.
function CompositeBar({ score }: { score: number }) {
  // Score is [-1, 1]. Bar starts at center (0) and extends left/right.
  const pct = Math.min(100, Math.abs(score) * 100);
  const positive = score >= 0;
  return (
    <div className="flex items-center gap-2">
      <span
        className={clsx(
          "w-[3.2rem] shrink-0 text-right font-mono text-[12px] tabular-nums",
          positive ? "text-success-fg" : "text-danger",
        )}
      >
        {score >= 0 ? "+" : ""}
        {score.toFixed(3)}
      </span>
      <div className="relative h-[6px] w-[80px] shrink-0 rounded-full bg-s2">
        <div
          className={clsx(
            "absolute top-0 h-full rounded-full",
            positive ? "left-1/2 bg-success" : "right-1/2 bg-danger",
          )}
          style={{ width: `${pct / 2}%` }}
        />
        <div className="absolute left-1/2 top-[-2px] h-[10px] w-[1px] bg-bd" />
      </div>
    </div>
  );
}

export function IdeasTable({
  ranking,
  initialState,
  highlightTicker,
}: {
  ranking: Ranking;
  initialState?: SharedState;
  // Deep-link target from /ideas?ticker=<T>. Row is scrolled into
  // view + ringed on mount. Coming from TickerSignals composite
  // badge on /s/[ticker].
  highlightTicker?: string | null;
}) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [minComponents, setMinComponents] = useState<MinComponents>(1);
  // "Matured only" — hides rows whose last event was < 5 calendar
  // days ago. Rough proxy for d3 reaction maturity (d3 = 3 trading
  // sessions ≈ 5 calendar days worst-case with weekends).
  // Underlying signals may be pending / clipped, so this filter
  // trades coverage for signal cleanliness.
  const [maturedOnly, setMaturedOnly] = useState<boolean>(false);
  const [query, setQuery] = useState("");
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Scroll to highlighted row once after mount + after
  // filter/sort resolves. behavior:smooth so the transition is
  // visible; block:center so the row lands mid-viewport.
  useEffect(() => {
    if (!highlightTicker) return;
    if (!highlightRef.current) return;
    highlightRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [highlightTicker]);

  // Focus set — hydrated from server-provided initialState so first
  // paint is correct. Local mutations flush to /api/shared-state
  // (fire-and-forget with rollback on failure). initialState might
  // be absent if the caller didn't wire it (e.g. embedded preview) —
  // in that case the ★ button no-ops silently.
  const [focus, setFocus] = useState<Set<string>>(
    () => new Set(initialState?.preferences?.focusTickers ?? []),
  );
  const [failed, setFailed] = useState<string | null>(null);

  const toggleFocus = async (ticker: string) => {
    if (!initialState) return;
    const wasIn = focus.has(ticker);
    const nextFocus = new Set(focus);
    if (wasIn) nextFocus.delete(ticker);
    else nextFocus.add(ticker);
    setFocus(nextFocus); // optimistic
    setFailed(null);
    try {
      const currentTickers = Array.from(nextFocus);
      const nextState: SharedState = {
        ...initialState,
        preferences: initialState.preferences
          ? { ...initialState.preferences, focusTickers: currentTickers }
          : {
              focusTickers: currentTickers,
              themes: initialState.themes ?? [],
              subscriptions: {
                newTranscripts: false,
                weekAhead: false,
                ideasDigest: false,
              },
            },
      };
      const r = await fetch("/api/shared-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextState),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      // rollback
      setFocus((prev) => {
        const rb = new Set(prev);
        if (wasIn) rb.add(ticker);
        else rb.delete(ticker);
        return rb;
      });
      setFailed(ticker);
    }
  };

  // Bulk-add: adds the top N visible rows (as currently sorted +
  // filtered) into focus in one PUT. Duplicates are silently
  // absorbed — Set() handles the dedupe.
  const bulkAddTopN = async (n: number, visible: RankingRow[]) => {
    if (!initialState) return;
    const before = new Set(focus);
    const nextFocus = new Set(focus);
    const added: string[] = [];
    for (const r of visible.slice(0, n)) {
      if (!nextFocus.has(r.ticker)) {
        nextFocus.add(r.ticker);
        added.push(r.ticker);
      }
    }
    if (added.length === 0) return; // nothing to do
    setFocus(nextFocus);
    setFailed(null);
    try {
      const currentTickers = Array.from(nextFocus);
      const nextState: SharedState = {
        ...initialState,
        preferences: initialState.preferences
          ? { ...initialState.preferences, focusTickers: currentTickers }
          : {
              focusTickers: currentTickers,
              themes: initialState.themes ?? [],
              subscriptions: {
                newTranscripts: false,
                weekAhead: false,
                ideasDigest: false,
              },
            },
      };
      const r = await fetch("/api/shared-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextState),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      setFocus(before);
      setFailed(`bulk: ${added.length} rows failed`);
    }
  };

  const maturityCutoffIso = useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 5);
    return d.toISOString().slice(0, 10);
  }, []);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return ranking.rows
      .filter((r) => r.componentsPresent >= minComponents)
      .filter((r) => {
        if (!maturedOnly) return true;
        // Require lastEventDate present AND >= 5 calendar days ago
        // — rough d3 maturity proxy.
        return !!r.lastEventDate && r.lastEventDate <= maturityCutoffIso;
      })
      .filter((r) => {
        if (!term) return true;
        return (
          r.ticker.toLowerCase().includes(term) ||
          r.displayName.toLowerCase().includes(term)
        );
      })
      .slice()
      .sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));
  }, [ranking.rows, sortKey, minComponents, query, maturedOnly, maturityCutoffIso]);

  return (
    <>
      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap rounded-button border border-bd bg-s1 p-[3px]">
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setSortKey(k)}
              className={clsx(
                "rounded-[6px] px-3 py-[5px] text-[12.5px]",
                sortKey === k
                  ? "bg-s3 font-medium text-tx"
                  : "text-tx2 hover:text-tx",
              )}
            >
              {SORT_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-button border border-bd bg-s1 px-2 py-[3px] text-[12px]">
          <span className="text-tx-mid">Min components</span>
          {([1, 2, 3] as MinComponents[]).map((n) => (
            <button
              key={n}
              onClick={() => setMinComponents(n)}
              className={clsx(
                "rounded-[4px] px-[7px] py-[2px] font-mono text-[11px]",
                minComponents === n
                  ? "bg-s3 text-tx"
                  : "text-tx-mid hover:text-tx",
              )}
            >
              ≥{n}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setMaturedOnly((v) => !v)}
          title="Hide rows whose last earnings event was < 5 calendar days ago (d3 reaction still stabilizing)"
          className={clsx(
            "rounded-button border px-3 py-[6px] text-[12.5px] transition",
            maturedOnly
              ? "border-brand bg-[rgba(47,127,255,0.10)] text-brand-fg"
              : "border-bd bg-s1 text-tx-mid hover:text-tx",
          )}
        >
          {maturedOnly ? "Matured only ✓" : "Matured only"}
        </button>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by ticker or name…"
          className="h-9 min-w-[240px] rounded-button border border-bd bg-s1 px-3 text-[13px] text-tx placeholder:text-tx3 focus:border-brand focus:outline-none"
        />
        {initialState ? (
          <div className="flex items-center gap-1 rounded-button border border-bd bg-s1 px-2 py-[3px] text-[12px]">
            <span className="text-tx-mid">Bulk focus</span>
            {[10, 20].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => bulkAddTopN(n, rows)}
                title={`Add the top ${n} rows (as currently sorted + filtered) to preferences.focusTickers in a single PUT`}
                className="rounded-[4px] bg-s3 px-[7px] py-[2px] font-mono text-[11px] text-tx hover:bg-hover"
              >
                +top {n}
              </button>
            ))}
          </div>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-tx3">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-[8px] border border-bd bg-panel">
        <div className="grid grid-cols-[2rem_3rem_2fr_10rem_5rem_7rem_7rem_7rem_5rem] gap-x-3 border-b border-bd px-4 py-2 font-mono text-[10px] uppercase tracking-[0.07em] text-tx3">
          <span />
          <span>Rank</span>
          <span>Name</span>
          <span>Composite</span>
          <span>Cap</span>
          <span className="text-right">Reaction</span>
          <span className="text-right">Surprise</span>
          <span className="text-right">Trend</span>
          <span className="text-right">Last</span>
        </div>
        {rows.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-tx-mid">
            No rows match the current filters.
          </div>
        ) : (
          rows.map((r) => {
            const inFocus = focus.has(r.ticker);
            const failedHere = failed === r.ticker;
            const isHighlighted = highlightTicker === r.ticker;
            return (
              <div
                key={r.ticker}
                ref={isHighlighted ? highlightRef : undefined}
                className={clsx(
                  "grid w-full grid-cols-[2rem_3rem_2fr_10rem_5rem_7rem_7rem_7rem_5rem] items-center gap-x-3 border-b border-bd/60 px-4 py-2 text-left text-[13px] hover:bg-hover",
                  isHighlighted &&
                    "ring-2 ring-brand/40 bg-[rgba(47,127,255,0.04)]",
                )}
              >
                {/* Star toggle — click swallowed via stopPropagation
                    so it doesn't navigate to /s/[ticker]. */}
                <button
                  type="button"
                  aria-pressed={inFocus}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFocus(r.ticker);
                  }}
                  disabled={!initialState}
                  title={
                    !initialState
                      ? "Focus toggle unavailable (no shared-state)"
                      : inFocus
                      ? "Remove from focus"
                      : "Add to focus"
                  }
                  className={clsx(
                    "flex h-5 w-5 items-center justify-center rounded-[3px] transition",
                    inFocus
                      ? "text-brand-fg hover:bg-hover"
                      : "text-tx3 hover:text-tx-mid hover:bg-hover",
                    !initialState && "cursor-not-allowed opacity-40",
                    failedHere && "text-danger",
                  )}
                >
                  {inFocus ? (
                    <Star size={13} className="fill-current" />
                  ) : (
                    <StarOff size={13} />
                  )}
                </button>
                {/* Everything after the star opens the ticker page. */}
                <button
                  type="button"
                  onClick={() => router.push(`/s/${encodeURIComponent(r.ticker)}`)}
                  className="col-span-8 grid w-full grid-cols-[3rem_2fr_10rem_5rem_7rem_7rem_7rem_5rem] items-center gap-x-3 text-left"
                >
                  <span className="font-mono text-[11px] text-tx-mid">
                    #{r.rank}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <TickerLogo ticker={r.ticker} name={r.displayName} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-tx">
                        {r.displayName}
                      </span>
                      <span className="font-mono text-[10.5px] text-brand-fg">
                        {r.ticker}
                      </span>
                    </span>
                  </span>
                  <CompositeBar score={r.compositeScore} />
                  <span className="font-mono text-[10.5px] uppercase text-tx3">
                    {CAP_LABEL[r.capTier] ?? "—"}
                  </span>
                  <span className="text-right">
                    <ComponentCell c={r.components.reaction} />
                  </span>
                  <span className="text-right">
                    <ComponentCell c={r.components.surprise} />
                  </span>
                  <span className="text-right">
                    <ComponentCell c={r.components.trend} />
                  </span>
                  <span className="text-right font-mono text-[10.5px] text-tx3">
                    {r.lastPeriod ?? "—"}
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
      {failed ? (
        <p className="mt-2 text-[11px] text-danger">
          Focus PUT failed for {failed}. Refresh the page and retry.
        </p>
      ) : null}
    </>
  );
}
