"use client";

// Big-movers strip on the home page — surfaces the top-20 earnings
// reactions across the SP500 ∪ R1000 ∪ isCore universe over the last
// 45 days. Zero new data: reads events-index.json entries that
// already carry `lastEventReactionPoints`.
//
// Deliberately NOT a composite score. The row is sorted by |d3
// absolute return|, so the user sees "what moved big" without a
// black-box ranking. Cap tier filter lets them scope to the size
// class they care about.

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { CapTier } from "@/lib/types";

export interface MoverRow {
  ticker: string;
  displayName: string;
  capTier: CapTier;
  period: string;
  eventDate: string;
  absD3: number; // e.g. 0.062 = +6.2%
  excessD3: number | null;
  surprisePct: number | null;
}

const CAP_TIERS: Array<{ id: CapTier | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "mega", label: "Mega" },
  { id: "large", label: "Large" },
  { id: "mid", label: "Mid" },
  { id: "small", label: "Small" },
];

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  const p = v * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  return `${mo} ${d.getUTCDate()}`;
}

export function MoversStrip({ rows }: { rows: MoverRow[] }) {
  const [filter, setFilter] = useState<CapTier | "all">("all");

  const filtered = useMemo(() => {
    const scoped = filter === "all" ? rows : rows.filter((r) => r.capTier === filter);
    return scoped.slice(0, 20);
  }, [rows, filter]);

  if (rows.length === 0) return null;

  return (
    <section
      aria-label="Recent earnings reactions"
      className="mb-6 rounded-[8px] border border-bd bg-panel"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-bd px-4 py-2">
        <h2 className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          § Big movers · last 45 days · d3 reaction
        </h2>
        <span className="font-mono text-[10.5px] text-tx3">
          {filtered.length} of {rows.length}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
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
      </header>

      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-tx-mid">
          No movers in this cap tier over the last 45 days.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-0 divide-y divide-bd sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
          {filtered.map((r) => {
            const posD3 = r.absD3 >= 0;
            const posExcess = r.excessD3 != null && r.excessD3 >= 0;
            return (
              <Link
                key={r.ticker}
                href={`/s/${encodeURIComponent(r.ticker)}`}
                className="flex items-center gap-3 border-bd px-3 py-2 hover:bg-hover sm:border-r sm:border-b sm:last:border-r-0 lg:border-b"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[11.5px] text-brand-fg">
                      {r.ticker}
                    </span>
                    <span className="truncate text-[11px] text-tx-mid">
                      {r.displayName}
                    </span>
                  </div>
                  <div className="mt-[1px] flex items-baseline gap-2 font-mono text-[10.5px] text-tx3">
                    <span>{r.period}</span>
                    <span>·</span>
                    <span>{fmtDate(r.eventDate)}</span>
                    {r.surprisePct != null ? (
                      <>
                        <span>·</span>
                        <span>surp {fmtPct(r.surprisePct / 100)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={clsx(
                      "font-mono text-[13px] font-semibold tabular-nums",
                      posD3 ? "text-success" : "text-danger",
                    )}
                  >
                    {fmtPct(r.absD3)}
                  </div>
                  {r.excessD3 != null ? (
                    <div
                      className={clsx(
                        "font-mono text-[10px] tabular-nums",
                        posExcess ? "text-success/70" : "text-danger/70",
                      )}
                    >
                      vs SPX {fmtPct(r.excessD3)}
                    </div>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
