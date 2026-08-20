"use client";

// Tiny inline SVG sparkline of a ticker's composite score over
// the last N days. Reads pre-fetched data from server; no client
// fetch. Silently renders nothing when history is too short.

import type { RankingHistoryRow } from "@/lib/types";

interface Props {
  history: RankingHistoryRow[];
  // Optional horizon — trims older rows if the caller passes a
  // longer history than needed. Defaults to 30 days.
  days?: number;
}

const WIDTH = 96;
const HEIGHT = 20;
const PAD = 2;

export function CompositeSparkline({ history, days = 30 }: Props) {
  if (!history || history.length < 2) return null;

  // History is expected sorted-by-append (which is chronological
  // in the append pipeline) but re-sort to be safe.
  const sorted = history
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days);
  if (sorted.length < 2) return null;

  const values = sorted.map((r) => r.composite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1; // avoid /0

  const w = WIDTH - 2 * PAD;
  const h = HEIGHT - 2 * PAD;

  const points = values
    .map((v, i) => {
      const x = PAD + (i / (values.length - 1)) * w;
      const y = PAD + h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const last = values[values.length - 1];
  const first = values[0];
  const delta = last - first;
  const stroke =
    delta > 0.05
      ? "var(--success)"
      : delta < -0.05
      ? "var(--danger)"
      : "var(--tx-mid)";

  const title = `Composite ${first.toFixed(2)} → ${last.toFixed(2)} over ${sorted.length} days (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`;

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Dot on the latest point */}
      <circle
        cx={PAD + w}
        cy={PAD + h - ((last - min) / range) * h}
        r="2"
        fill={stroke}
      />
    </svg>
  );
}
