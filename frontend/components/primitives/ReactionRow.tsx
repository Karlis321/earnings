"use client";

// Compact reaction strip for past events. Renders four horizons in a row:
//   +1d +3.2% · +3d +5.1% · 1w +4.8% · 1m +2.1% (clipped)
// Pending / null / unavailable horizons render as "+1m —" (never blank).
// `clipped` appends "(clipped)" to just that horizon.
// `contaminated` wraps that horizon at opacity-60 with a hover title
//   ("⚠ contaminated") so a newer event inside the window is disclosed.
//
// Extracted from the inline block that lived inside OperatingDetail —
// re-used on the event-detail header, sector member rows, and the
// watchlist expanded row.

import type { Horizon, ReactionPoint } from "@/lib/types";

const HORIZON_LABEL: Record<Horizon, string> = {
  d1: "+1d",
  d3: "+3d",
  w1: "1w",
  m1: "1m",
};
const HORIZON_ORDER: Horizon[] = ["d1", "d3", "w1", "m1"];

function fmtPct(v: number): string {
  const pct = v * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function ReactionRow({
  points,
  size = "sm",
}: {
  points: ReactionPoint[];
  size?: "sm" | "xs";
}) {
  const byH = new Map<Horizon, ReactionPoint>();
  for (const p of points) byH.set(p.horizon, p);
  const textSize = size === "xs" ? "text-[10.5px]" : "text-[11px]";
  return (
    <div
      className={`font-mono ${textSize} text-tx-mid flex flex-wrap items-center gap-x-2 gap-y-0.5`}
    >
      {HORIZON_ORDER.map((h, idx) => {
        const p = byH.get(h);
        const label = HORIZON_LABEL[h];
        if (!p || p.absReturn === null || p.absReturn === undefined) {
          return (
            <span key={h}>
              {idx > 0 ? <span className="text-tx3 mr-2">·</span> : null}
              {label} <span className="text-tx3">—</span>
            </span>
          );
        }
        const contaminated = p.contaminated === true;
        const clipped = p.clipped === true;
        return (
          <span
            key={h}
            className={contaminated ? "opacity-60" : ""}
            title={
              contaminated
                ? "⚠ contaminated — newer event inside the window"
                : undefined
            }
          >
            {idx > 0 ? <span className="text-tx3 mr-2">·</span> : null}
            {label}{" "}
            <span className="text-tx">{fmtPct(p.absReturn)}</span>
            {clipped ? <span className="text-tx3"> (clipped)</span> : null}
            {contaminated ? <span className="ml-1 text-tx3">⚠</span> : null}
          </span>
        );
      })}
    </div>
  );
}
