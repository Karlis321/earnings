"use client";

// Multi-horizon reaction: d1/d3/w1/m1, abs + excess vs benchmark.
// Pending horizons show "pending — populates <date>", not zero. (FE PRD §6, §9.)

import type { ReactionPoint } from "@/lib/types";
import clsx from "clsx";

interface Props {
  points: ReactionPoint[];
  variant?: "spark" | "full";
  benchmark?: string;
}

const HORIZON_LABEL: Record<string, string> = {
  d1: "+1d",
  d3: "+3d",
  w1: "+1w",
  m1: "+1m",
};

export function ReactionChart({ points, variant = "full", benchmark }: Props) {
  if (variant === "spark") return <Sparkline points={points} />;
  return <Full points={points} benchmark={benchmark} />;
}

function Sparkline({ points }: { points: ReactionPoint[] }) {
  const w = 88;
  const h = 24;
  const vals = points.map((p) => p.absReturn ?? 0);
  const anyPending = points.some((p) => p.absReturn === null);
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const range = max - min || 1;
  const step = w / Math.max(points.length - 1, 1);
  const path = points
    .map((p, i) => {
      const x = i * step;
      const y = h - ((p.absReturn ?? 0) - min) / range * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const finalVal = vals[vals.length - 1];
  const color = anyPending
    ? "var(--tx-mid)"
    : finalVal >= 0
    ? "#4ade80"
    : "#f87171";
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Reaction sparkline: ${points
        .map(
          (p) =>
            `${HORIZON_LABEL[p.horizon]} ${
              p.absReturn === null
                ? "pending"
                : `${(p.absReturn * 100).toFixed(1)}%`
            }`,
        )
        .join(", ")}`}
    >
      <polyline
        points={path}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={anyPending ? "3 3" : undefined}
      />
    </svg>
  );
}

function Full({
  points,
  benchmark,
}: {
  points: ReactionPoint[];
  benchmark?: string;
}) {
  return (
    <div>
      <div className="mono-eyebrow mb-3 flex items-center gap-2">
        Reaction
        {benchmark ? (
          <span className="text-tx-mid normal-case">
            · vs <span className="font-mono">{benchmark}</span>
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-4 gap-3">
        {points.map((p) => (
          <HorizonCell key={p.horizon} point={p} />
        ))}
      </div>
    </div>
  );
}

function HorizonCell({ point }: { point: ReactionPoint }) {
  const pending = point.absReturn === null;
  const isPos = (point.absReturn ?? 0) > 0;
  const isNeg = (point.absReturn ?? 0) < 0;
  return (
    <div
      className={clsx(
        "rounded-card border border-bd bg-s1 px-3 py-3",
        point.gapFlagged && "border-warning/40",
      )}
    >
      <div className="mono-eyebrow mb-2">{HORIZON_LABEL[point.horizon]}</div>

      {pending ? (
        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-tx-mid">Pending</span>
          <span className="font-mono text-[11px] text-tx3">
            populates {point.populatesOn ?? "—"}
          </span>
        </div>
      ) : (
        <>
          <div
            className={clsx(
              "font-mono text-[16px] font-semibold",
              isPos && "text-[#4ade80]",
              isNeg && "text-danger",
            )}
          >
            {isPos ? "+" : ""}
            {(point.absReturn! * 100).toFixed(1)}%
          </div>
          <div className="font-mono text-[11px] text-tx-mid">
            excess {(point.excessReturn ?? 0) >= 0 ? "+" : ""}
            {((point.excessReturn ?? 0) * 100).toFixed(1)}%
          </div>
          {point.gapFlagged ? (
            <div className="mt-2 text-[10.5px] text-warning">
              benchmark price gap
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
