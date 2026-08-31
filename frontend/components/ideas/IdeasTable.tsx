"use client";

// Client table for /ideas. Renders the mechanical composite ranking
// from data/ranking.json (Feature 3A) with sort-mode buttons and a
// cap-tier filter. Deliberately shows the raw components alongside
// the composite so the user can defend any ranking by pointing at
// inputs, not a black-box score.

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { CapTier, RankingRow } from "@/lib/types";
import { useLastVisit, isNewSince } from "@/lib/useLastVisit";
import { fmtPct, fmtSurprisePct, fmtMonthDay } from "@/lib/format";

type SortMode = "composite" | "reaction" | "surprise" | "date";

const CAP_TIERS: Array<{ id: CapTier | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "mega", label: "Mega" },
  { id: "large", label: "Large" },
  { id: "mid", label: "Mid" },
  { id: "small", label: "Small" },
];

const SORT_MODES: Array<{ id: SortMode; label: string }> = [
  { id: "composite", label: "Composite" },
  { id: "reaction", label: "Reaction" },
  { id: "surprise", label: "Surprise" },
  { id: "date", label: "Recency" },
];

export function IdeasTable({
  rows,
  focusTickers = [],
}: {
  rows: RankingRow[];
  focusTickers?: string[];
}) {
  const [sort, setSort] = useState<SortMode>("composite");
  const [filter, setFilter] = useState<CapTier | "all">("all");
  const [focusOnly, setFocusOnly] = useState(false);
  const { cutoff } = useLastVisit();
  const focusSet = useMemo(() => new Set(focusTickers), [focusTickers]);

  const sorted = useMemo(() => {
    let scoped = filter === "all" ? rows : rows.filter((r) => r.capTier === filter);
    if (focusOnly) scoped = scoped.filter((r) => focusSet.has(r.ticker));
    return [...scoped].sort((a, b) => {
      switch (sort) {
        case "reaction": {
          const av = a.components.reaction.absReturn ?? 0;
          const bv = b.components.reaction.absReturn ?? 0;
          return Math.abs(bv) - Math.abs(av);
        }
        case "surprise": {
          const av = a.components.surprise.pct ?? 0;
          const bv = b.components.surprise.pct ?? 0;
          return Math.abs(bv) - Math.abs(av);
        }
        case "date":
          return b.eventDate.localeCompare(a.eventDate);
        case "composite":
        default:
          return b.composite - a.composite;
      }
    });
  }, [rows, sort, filter, focusOnly, focusSet]);

  return (
    <div className="rounded-[8px] border border-bd bg-panel">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-bd px-4 py-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          Sort
        </span>
        <div className="flex flex-wrap gap-1">
          {SORT_MODES.map((m) => {
            const active = sort === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setSort(m.id)}
                className={clsx(
                  "rounded-[4px] border px-1.5 py-[2px] font-mono text-[10.5px]",
                  active
                    ? "border-brand/40 bg-brand/10 text-brand-fg"
                    : "border-bd text-tx-mid hover:border-brand/40 hover:text-brand-fg",
                )}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <span className="ml-4 font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          Cap
        </span>
        <div className="flex flex-wrap gap-1">
          {CAP_TIERS.map((t) => {
            const active = filter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setFilter(t.id)}
                className={clsx(
                  "rounded-[4px] border px-1.5 py-[2px] font-mono text-[10.5px]",
                  active
                    ? "border-brand/40 bg-brand/10 text-brand-fg"
                    : "border-bd text-tx-mid hover:border-brand/40 hover:text-brand-fg",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {focusTickers.length > 0 ? (
          <button
            type="button"
            onClick={() => setFocusOnly((v) => !v)}
            className={clsx(
              "ml-4 rounded-[4px] border px-1.5 py-[2px] font-mono text-[10.5px]",
              focusOnly
                ? "border-brand/40 bg-brand/10 text-brand-fg"
                : "border-bd text-tx-mid hover:border-brand/40 hover:text-brand-fg",
            )}
            title={`Filter to your ${focusTickers.length} focus tickers`}
          >
            Focus only
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[10.5px] text-tx3">
          {sorted.length} rows
        </span>
      </header>

      {sorted.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-tx-mid">
          No rows match the current filter.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-bd font-mono text-[10px] uppercase tracking-[0.06em] text-tx3">
                <th className="w-8 px-3 py-1.5 text-right">#</th>
                <th className="px-3 py-1.5 text-left">Ticker</th>
                <th className="px-3 py-1.5 text-left">Name</th>
                <th className="px-3 py-1.5 text-left">Period</th>
                <th className="px-3 py-1.5 text-left">Date</th>
                <th className="px-3 py-1.5 text-right">d3</th>
                <th className="px-3 py-1.5 text-right">vs SPX</th>
                <th className="px-3 py-1.5 text-right">Surp</th>
                <th className="px-3 py-1.5 text-right">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bd/60">
              {sorted.map((r, i) => {
                const abs = r.components.reaction.absReturn;
                const exc = r.components.reaction.excessReturn;
                const surp = r.components.surprise.pct;
                const isNew = isNewSince(r.eventDate, cutoff);
                const isFocus = focusSet.has(r.ticker);
                return (
                  <tr key={r.ticker} className="hover:bg-hover">
                    <td className="px-3 py-1.5 text-right font-mono text-[10.5px] text-tx3">
                      {i + 1}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/s/${encodeURIComponent(r.ticker)}`}
                          className="font-mono text-brand-fg hover:underline"
                        >
                          {r.ticker}
                        </Link>
                        {isFocus ? (
                          <span
                            className="rounded-[3px] border border-brand/40 bg-brand/10 px-1 font-mono text-[9px] uppercase tracking-[0.06em] text-brand-fg"
                            title="Focus ticker"
                          >
                            focus
                          </span>
                        ) : null}
                        {isNew ? (
                          <span
                            className="rounded-[3px] border border-brand/40 bg-brand/10 px-1 font-mono text-[9px] uppercase tracking-[0.06em] text-brand-fg"
                            title={`Newer than your last visit (${cutoff?.slice(0, 10)})`}
                          >
                            new
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="max-w-[240px] truncate px-3 py-1.5 text-tx-mid">
                      {r.displayName}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-tx-mid">
                      {r.period ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-tx-mid">
                      {fmtMonthDay(r.eventDate)}
                    </td>
                    <td
                      className={clsx(
                        "px-3 py-1.5 text-right font-mono tabular-nums",
                        abs == null ? "text-tx3" : abs >= 0 ? "text-success" : "text-danger",
                      )}
                    >
                      {fmtPct(abs)}
                    </td>
                    <td
                      className={clsx(
                        "px-3 py-1.5 text-right font-mono text-[11px] tabular-nums",
                        exc == null ? "text-tx3" : exc >= 0 ? "text-success/70" : "text-danger/70",
                      )}
                    >
                      {fmtPct(exc)}
                    </td>
                    <td
                      className={clsx(
                        "px-3 py-1.5 text-right font-mono tabular-nums",
                        surp == null ? "text-tx3" : surp >= 0 ? "text-success" : "text-danger",
                      )}
                    >
                      {fmtSurprisePct(surp)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold tabular-nums text-tx">
                      {r.composite.toFixed(3)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
