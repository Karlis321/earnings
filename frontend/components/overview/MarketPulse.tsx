"use client";

// Overview mini-chart — 1-month S&P 500 price series from /api/prices.
// SVG-based, no chart library. Hover crosshair with tooltip.

import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";

interface PricePoint {
  date: string;
  close: number;
}
interface PricesResponse {
  symbol: string;
  range: string;
  interval: string;
  series: PricePoint[];
  fetchedAt: string;
}

const INDICES: Array<{ symbol: string; label: string }> = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^NDX", label: "Nasdaq 100" },
  { symbol: "^STOXX50E", label: "Euro Stoxx 50" },
  { symbol: "^VIX", label: "VIX" },
];

export function MarketPulse() {
  const [active, setActive] = useState(INDICES[0]);
  const [data, setData] = useState<PricesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    setData(null);
    const url = `/api/prices?symbol=${encodeURIComponent(active.symbol)}&range=1mo`;
    fetch(url, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((j: PricesResponse) => setData(j))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [active.symbol]);

  return (
    <div className="mb-6 rounded-panel border border-bd bg-s1 p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="mono-eyebrow mb-1">Market pulse · 1 month</div>
          <div className="text-[13px] text-tx-mid">
            Live closes via Yahoo · updated at load
          </div>
        </div>
        <div className="flex gap-1 rounded-button border border-bd bg-s2 p-[3px]">
          {INDICES.map((idx) => (
            <button
              key={idx.symbol}
              onClick={() => setActive(idx)}
              className={
                active.symbol === idx.symbol
                  ? "rounded-[6px] bg-brand px-3 py-[5px] text-[12px] font-medium text-white"
                  : "rounded-[6px] px-3 py-[5px] text-[12px] text-tx2 hover:text-tx"
              }
            >
              {idx.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-tx-mid">
          <Loader2 size={14} className="animate-spin" />
          Fetching {active.label} · 1-month series…
        </div>
      ) : err ? (
        <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-danger">
          <AlertTriangle size={14} />
          Failed to load {active.label}: {err}
        </div>
      ) : data && data.series.length > 1 ? (
        <PriceChart series={data.series} label={active.label} />
      ) : (
        <div className="flex h-[220px] items-center justify-center text-[13px] text-tx-mid">
          No data returned.
        </div>
      )}
    </div>
  );
}

interface ChartProps {
  series: PricePoint[];
  label: string;
}

function PriceChart({ series, label }: ChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

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

  if (!stats) return null;

  // Chart geometry
  const W = 900;
  const H = 200;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const range = stats.max - stats.min || 1;
  const step = chartW / Math.max(series.length - 1, 1);

  const points = series.map((p, i) => ({
    x: padL + i * step,
    y: padT + (1 - (p.close - stats.min) / range) * chartH,
    close: p.close,
    date: p.date,
  }));

  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath =
    `M ${points[0].x.toFixed(1)},${(padT + chartH).toFixed(1)} ` +
    `L ${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")} ` +
    `L ${points[points.length - 1].x.toFixed(1)},${(padT + chartH).toFixed(1)} Z`;

  const isUp = stats.change >= 0;
  const lineColor = isUp ? "#039855" : "#b42318";
  const fillId = isUp ? "up-fill" : "down-fill";
  const fillColor = isUp ? "18, 183, 106" : "180, 35, 24";

  // Y-axis ticks
  const yTicks = [
    stats.min,
    stats.min + range / 3,
    stats.min + (2 * range) / 3,
    stats.max,
  ];

  const active = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div>
      {/* Stats row */}
      <div className="mb-3 flex items-end gap-6">
        <div>
          <div className="text-[13px] text-tx-mid">{label}</div>
          <div className="mt-1 font-mono text-[28px] font-semibold tabular-nums text-tx">
            {stats.last.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div
          className="pb-2 font-mono text-[15px] font-semibold tabular-nums"
          style={{ color: lineColor }}
        >
          {stats.change >= 0 ? "+" : ""}
          {stats.change.toFixed(2)} ({stats.pct >= 0 ? "+" : ""}
          {stats.pct.toFixed(2)}%)
        </div>
        <div className="pb-2 text-[12px] text-tx3">
          {series[0].date} → {series[series.length - 1].date}
        </div>
      </div>

      {/* Chart */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`${label} 1-month price chart`}
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const scale = W / rect.width;
          const x = (e.clientX - rect.left) * scale;
          if (x < padL || x > W - padR) {
            setHoverIdx(null);
            return;
          }
          const idx = Math.min(
            series.length - 1,
            Math.max(0, Math.round((x - padL) / step)),
          );
          setHoverIdx(idx);
        }}
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`rgba(${fillColor}, 0.20)`} />
            <stop offset="100%" stopColor={`rgba(${fillColor}, 0)`} />
          </linearGradient>
        </defs>

        {/* Y-axis grid + labels */}
        {yTicks.map((v, i) => {
          const y = padT + (1 - (v - stats.min) / range) * chartH;
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
                {v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </text>
            </g>
          );
        })}

        {/* X-axis dates (start / mid / end) */}
        {[0, Math.floor(series.length / 2), series.length - 1].map((i) => {
          const p = points[i];
          if (!p) return null;
          return (
            <text
              key={i}
              x={p.x}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
              fill="#6b7684"
              fontSize={11}
              fontFamily="var(--font-ibm-sans), sans-serif"
            >
              {p.date.slice(5)}
            </text>
          );
        })}

        {/* Area fill */}
        <path d={areaPath} fill={`url(#${fillId})`} />
        {/* Line */}
        <polyline
          points={path}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Hover crosshair */}
        {active ? (
          <g>
            <line
              x1={active.x}
              y1={padT}
              x2={active.x}
              y2={padT + chartH}
              stroke="rgba(10,15,20,0.20)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle
              cx={active.x}
              cy={active.y}
              r={4}
              fill={lineColor}
              stroke="#fff"
              strokeWidth={2}
            />
          </g>
        ) : null}
      </svg>

      {/* Tooltip */}
      {active ? (
        <div className="mt-2 flex items-center gap-3 font-mono text-[12px] text-tx-mid">
          <span className="text-tx">{active.date}</span>
          <span className="text-tx-strong">
            {active.close.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
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
