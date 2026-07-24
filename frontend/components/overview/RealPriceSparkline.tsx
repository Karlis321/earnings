"use client";

// Overview-row 1-month sparkline built from real Yahoo daily closes.
// Consumed alongside a percent-change label. Data comes from the
// PricesContext (populated by MarketPulse / Overview at page load).

interface Props {
  series: { date: string; close: number }[];
  loading?: boolean;
  err?: string | null;
}

export function RealPriceSparkline({ series, loading, err }: Props) {
  if (loading) {
    return (
      <span
        aria-label="Loading price series"
        className="inline-block h-[24px] w-[88px] animate-pulse rounded-[4px] bg-s2"
      />
    );
  }
  if (err || series.length < 2) {
    return (
      <span
        title={err ?? "no data"}
        className="text-[10.5px] text-tx3"
      >
        —
      </span>
    );
  }
  const W = 88;
  const H = 24;
  const vals = series.map((p) => p.close);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = W / Math.max(series.length - 1, 1);
  const path = series
    .map((p, i) => {
      const x = i * step;
      const y = H - ((p.close - min) / range) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = series[0].close;
  const last = series[series.length - 1].close;
  const isUp = last >= first;
  const color = isUp ? "#039855" : "#b42318";
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`1-month price sparkline: ${first.toFixed(2)} → ${last.toFixed(2)}`}
    >
      <polyline
        points={path}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Delta label for 1-month percent change. Colored + concise.
export function PriceDeltaLabel({ pctChange }: { pctChange: number | null }) {
  if (pctChange === null || Number.isNaN(pctChange)) {
    return <span className="text-[11px] text-tx3">—</span>;
  }
  const isUp = pctChange >= 0;
  return (
    <span
      className="font-mono text-[11px] font-medium tabular-nums"
      style={{ color: isUp ? "var(--success-fg)" : "var(--danger)" }}
    >
      {isUp ? "+" : ""}
      {pctChange.toFixed(2)}%
    </span>
  );
}
