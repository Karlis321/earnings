"use client";

// SVG price chart · line + area + hover crosshair + axes.
// No chart library; ~5 KB.

import { useMemo, useRef, useState } from "react";

export interface PricePoint {
  date: string;
  close: number;
}

interface Props {
  series: PricePoint[];
  label: string;
  height?: number;
  showStats?: boolean;
  currency?: string;
}

export function PriceChart({
  series,
  label,
  height = 200,
  showStats = true,
  currency,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastIdxRef = useRef<number | null>(null);

  const stats = useMemo(() => {
    if (series.length < 2) return null;
    const first = series[0].close;
    const last = series[series.length - 1].close;
    const change = last - first;
    const pct = (change / first) * 100;
    const values = series.map((p) => p.close);
    return {
      first,
      last,
      change,
      pct,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }, [series]);

  if (!stats) {
    return (
      <div className="flex h-[220px] items-center justify-center text-[13px] text-tx-mid">
        Not enough data.
      </div>
    );
  }

  // Geometry
  const W = 900;
  const H = height;
  const padL = 62;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  // Y-axis: pad the range 5% each side for aesthetic breathing room
  const yPad = (stats.max - stats.min) * 0.05 || stats.max * 0.02 || 1;
  const yMin = stats.min - yPad;
  const yMax = stats.max + yPad;
  const yRange = yMax - yMin || 1;
  const step = chartW / Math.max(series.length - 1, 1);

  const points = series.map((p, i) => ({
    x: padL + i * step,
    y: padT + (1 - (p.close - yMin) / yRange) * chartH,
    close: p.close,
    date: p.date,
  }));

  const linePath = points
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    `M ${points[0].x.toFixed(1)},${(padT + chartH).toFixed(1)} ` +
    `L ${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")} ` +
    `L ${points[points.length - 1].x.toFixed(1)},${(padT + chartH).toFixed(1)} Z`;

  const isUp = stats.change >= 0;
  const lineColor = isUp ? "#039855" : "#b42318";
  const fillRgb = isUp ? "18, 183, 106" : "180, 35, 24";
  const gradId = `pcg-${Math.random().toString(36).slice(2, 8)}`;

  // Y-axis ticks — 5 evenly spaced
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (i * yRange) / 4);

  // X-axis — 5 evenly spaced date labels
  const xTickIdx = Array.from({ length: 5 }, (_, i) =>
    Math.round(((series.length - 1) * i) / 4),
  );

  const active = hoverIdx !== null ? points[hoverIdx] : null;

  const fmt = (v: number) =>
    v.toLocaleString(undefined, {
      maximumFractionDigits: v >= 1000 ? 0 : 2,
      minimumFractionDigits: v >= 1000 ? 0 : 2,
    });

  return (
    <div>
      {showStats ? (
        <div className="mb-3 flex items-end gap-6">
          <div>
            <div className="text-[13px] text-tx-mid">{label}</div>
            <div className="mt-1 font-mono text-[28px] font-semibold tabular-nums text-tx">
              {fmt(stats.last)}
              {currency ? (
                <span className="ml-1 text-[13px] font-normal text-tx-mid">
                  {currency}
                </span>
              ) : null}
            </div>
          </div>
          <div
            className="pb-2 font-mono text-[15px] font-semibold tabular-nums"
            style={{ color: lineColor }}
          >
            {isUp ? "+" : ""}
            {stats.change.toFixed(2)} ({isUp ? "+" : ""}
            {stats.pct.toFixed(2)}%)
          </div>
          <div className="pb-2 text-[12px] text-tx3">
            {series[0].date} → {series[series.length - 1].date}
          </div>
        </div>
      ) : null}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`${label} price chart`}
        onMouseLeave={() => {
          if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
          lastIdxRef.current = null;
          setHoverIdx(null);
        }}
        onMouseMove={(e) => {
          // Cache the clientX; do the heavy work inside rAF so we only
          // hit at most one update per frame — kills the cursor lag.
          const clientX = e.clientX;
          const target = e.currentTarget;
          if (rafRef.current !== null) return;
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            const rect = target.getBoundingClientRect();
            const scale = W / rect.width;
            const x = (clientX - rect.left) * scale;
            if (x < padL || x > W - padR) {
              if (lastIdxRef.current !== null) {
                lastIdxRef.current = null;
                setHoverIdx(null);
              }
              return;
            }
            const idx = Math.min(
              series.length - 1,
              Math.max(0, Math.round((x - padL) / step)),
            );
            // Guard: only re-render when the index actually changes.
            if (idx !== lastIdxRef.current) {
              lastIdxRef.current = idx;
              setHoverIdx(idx);
            }
          });
        }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`rgba(${fillRgb}, 0.20)`} />
            <stop offset="100%" stopColor={`rgba(${fillRgb}, 0)`} />
          </linearGradient>
        </defs>

        {/* Y-axis grid + labels */}
        {yTicks.map((v, i) => {
          const y = padT + (1 - (v - yMin) / yRange) * chartH;
          return (
            <g key={i}>
              <line
                x1={padL}
                y1={y}
                x2={W - padR}
                y2={y}
                stroke="rgba(10,15,20,0.06)"
                strokeWidth={1}
              />
              <text
                x={padL - 8}
                y={y + 4}
                textAnchor="end"
                fill="#6b7684"
                fontSize={11}
                fontFamily="var(--font-ibm-sans), sans-serif"
              >
                {fmt(v)}
              </text>
            </g>
          );
        })}

        {/* X-axis dates */}
        {xTickIdx.map((i, k) => {
          const p = points[i];
          if (!p) return null;
          return (
            <text
              key={k}
              x={p.x}
              y={H - 8}
              textAnchor={k === 0 ? "start" : k === xTickIdx.length - 1 ? "end" : "middle"}
              fill="#6b7684"
              fontSize={11}
              fontFamily="var(--font-ibm-sans), sans-serif"
            >
              {p.date.slice(5)}
            </text>
          );
        })}

        <path d={areaPath} fill={`url(#${gradId})`} />
        <polyline
          points={linePath}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Per-day markers. Radius scales down as points get closer together
            so a 5y chart doesn't turn into a smear of overlapping dots. */}
        {step >= 4
          ? points.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={step >= 16 ? 3 : step >= 8 ? 2.2 : 1.6}
                fill="#fff"
                stroke={lineColor}
                strokeWidth={1.4}
              />
            ))
          : null}

        {active ? (
          <g>
            <line
              x1={active.x}
              y1={padT}
              x2={active.x}
              y2={padT + chartH}
              stroke="rgba(10,15,20,0.28)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {/* Larger highlight dot at the hover point */}
            <circle
              cx={active.x}
              cy={active.y}
              r={6}
              fill={lineColor}
              stroke="#fff"
              strokeWidth={2.5}
            />
          </g>
        ) : null}
      </svg>

      {active ? (
        <div className="mt-2 flex items-center gap-3 font-mono text-[12px] text-tx-mid">
          <span className="text-tx">{active.date}</span>
          <span className="font-semibold text-tx-strong">{fmt(active.close)}</span>
          <span
            style={{
              color:
                active.close - stats.first >= 0
                  ? "var(--success-fg)"
                  : "var(--danger)",
            }}
          >
            {active.close - stats.first >= 0 ? "+" : ""}
            {(((active.close - stats.first) / stats.first) * 100).toFixed(2)}%
            &nbsp;from start
          </span>
        </div>
      ) : (
        <div className="mt-2 text-[11.5px] text-tx3">
          Hover the chart for the price on a specific day.
        </div>
      )}
    </div>
  );
}
