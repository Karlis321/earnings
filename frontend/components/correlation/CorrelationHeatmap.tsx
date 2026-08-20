"use client";

// Phase 4.1 — pairwise correlation heatmap. Cells are color-scaled
// from red (−1) → neutral (0) → green (+1). Diagonal (self) is
// suppressed to gray. Hover reveals the pair + numeric value.

import Link from "next/link";
import clsx from "clsx";
import type { Correlations } from "@/lib/types";

interface Props {
  data: Correlations;
}

function cellBg(v: number | null, isSelf: boolean): string {
  if (isSelf) return "bg-panel3/60";
  if (v === null) return "bg-panel2/40";
  // Red → neutral → green. Amplify around the extremes so 0.3 is
  // clearly warmer than 0.1 without saturating too early.
  const clamped = Math.max(-1, Math.min(1, v));
  const abs = Math.abs(clamped);
  const alpha = (0.15 + abs * 0.55).toFixed(2);
  if (clamped >= 0) {
    return `bg-[rgba(34,197,94,${alpha})]`;
  }
  return `bg-[rgba(239,68,68,${alpha})]`;
}

function cellText(v: number | null, isSelf: boolean): string {
  if (isSelf) return "text-tx3";
  if (v === null) return "text-tx3";
  return Math.abs(v) > 0.55 ? "text-white" : "text-tx-hi";
}

function fmt(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(2);
}

export function CorrelationHeatmap({ data }: Props) {
  const { tickers, matrix } = data;
  if (tickers.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-bd bg-panel2/40 px-4 py-6 text-[13px] text-tx-mid">
        Correlation snapshot is empty — the refresh script hasn't produced any tickers.
      </div>
    );
  }

  // 90px per data column keeps small watchlists (≤18 tickers) fitting
  // most laptop widths without horizontal scroll on the labels col.
  const CELL_PX = 44;
  const LABEL_PX = 96;

  return (
    <div className="overflow-x-auto rounded-[8px] border border-bd bg-panel2/60">
      <table
        className="border-collapse font-mono text-[10.5px] tabular-nums"
        style={{ borderSpacing: 0 }}
      >
        <thead>
          <tr>
            <th
              className="sticky left-0 top-0 z-20 border-b border-bd bg-panel2 px-2 py-1 text-left text-tx3"
              style={{ width: LABEL_PX, minWidth: LABEL_PX }}
            >
              &nbsp;
            </th>
            {tickers.map((t) => (
              <th
                key={t}
                className="border-b border-bd bg-panel2 px-1 py-1 text-center text-tx-mid"
                style={{ width: CELL_PX, minWidth: CELL_PX }}
                title={t}
              >
                <span className="inline-block rotate-[-45deg] whitespace-nowrap text-[10px]">
                  {t}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickers.map((rowTicker) => (
            <tr key={rowTicker}>
              <th
                className="sticky left-0 z-10 border-r border-bd bg-panel2 px-2 py-1 text-right font-normal text-tx-mid"
                style={{ width: LABEL_PX, minWidth: LABEL_PX }}
              >
                <Link
                  href={`/s/${encodeURIComponent(rowTicker)}`}
                  className="text-brand-fg hover:underline"
                >
                  {rowTicker}
                </Link>
              </th>
              {tickers.map((colTicker) => {
                const v = matrix[rowTicker]?.[colTicker] ?? null;
                const isSelf = rowTicker === colTicker;
                return (
                  <td
                    key={colTicker}
                    className={clsx(
                      "border-b border-r border-bd/40 px-0 py-1 text-center",
                      cellBg(v, isSelf),
                      cellText(v, isSelf),
                    )}
                    style={{ width: CELL_PX, minWidth: CELL_PX }}
                    title={
                      isSelf
                        ? `${rowTicker} · self`
                        : v === null
                        ? `${rowTicker} vs ${colTicker} · insufficient overlap`
                        : `${rowTicker} vs ${colTicker} · ρ = ${v.toFixed(3)}`
                    }
                  >
                    {isSelf ? "·" : fmt(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
