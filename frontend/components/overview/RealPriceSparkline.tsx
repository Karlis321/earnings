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
    // Shimmering placeholder line that hints at "this is a sparkline
    // loading" — moving gradient plus a subtle stroke path so the row
    // doesn't look like a broken cell while Yahoo bars are in flight.
    return (
      <svg
        width={88}
        height={24}
        viewBox="0 0 88 24"
        role="img"
        aria-label="Loading price series"
        className="overflow-visible"
      >
        <defs>
          <linearGradient id="sparkShimmer" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--tx3)" stopOpacity="0.15" />
            <stop offset="50%" stopColor="var(--tx3)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--tx3)" stopOpacity="0.15" />
            <animate
              attributeName="x1"
              from="-1"
              to="1"
              dur="1.4s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="x2"
              from="0"
              to="2"
              dur="1.4s"
              repeatCount="indefinite"
            />
          </linearGradient>
        </defs>
        <polyline
          points="0,14 12,10 24,15 36,8 48,12 60,6 72,11 88,9"
          fill="none"
          stroke="url(#sparkShimmer)"
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
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
