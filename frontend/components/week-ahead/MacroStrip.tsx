"use client";

// Feature 2C — macro extremity strip on /week-ahead. Renders each
// market-priced series as a chip with flag color (extreme/elevated/
// normal). Extreme + elevated bubble to the front; normal cluster
// at the tail. Hover surfaces the interpretation string. No click-
// through — these are pure context, not linked to a ticker.

import clsx from "clsx";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { MacroSignal, MacroSignals } from "@/lib/types";

const FLAG_STYLE: Record<
  "normal" | "elevated" | "extreme",
  { border: string; bg: string; text: string; label: string }
> = {
  extreme: {
    border: "border-[rgba(180,35,24,0.42)]",
    bg: "bg-[rgba(180,35,24,0.08)]",
    text: "text-danger",
    label: "> 2σ",
  },
  elevated: {
    border: "border-[rgba(202,138,4,0.38)]",
    bg: "bg-[rgba(202,138,4,0.08)]",
    text: "text-[rgba(202,138,4,1)]",
    label: "> 1σ",
  },
  normal: {
    border: "border-bd",
    bg: "bg-s1",
    text: "text-tx-mid",
    label: "",
  },
};

const FLAG_ORDER: Record<MacroSignal["flag"], number> = {
  extreme: 0,
  elevated: 1,
  normal: 2,
};

function Chip({ s }: { s: MacroSignal }) {
  const style = FLAG_STYLE[s.flag];
  const Icon =
    s.zScore > 0.5 ? TrendingUp : s.zScore < -0.5 ? TrendingDown : Minus;
  return (
    <div
      className={clsx(
        "inline-flex items-center gap-2 rounded-[6px] border px-2.5 py-1 text-[11.5px]",
        style.border,
        style.bg,
      )}
      title={`${s.interpretation}. Latest ${s.latest} on ${s.latestDate} · 3y mean ${s.window.mean} · stdev ${s.window.stdev}`}
    >
      <Icon aria-hidden className={clsx("h-[11px] w-[11px]", style.text)} />
      <span className="font-mono text-tx3">{s.key}</span>
      <span className="text-tx">{s.latest.toLocaleString()}</span>
      <span className={clsx("font-mono text-[10.5px] tabular-nums", style.text)}>
        z={s.zScore >= 0 ? "+" : ""}
        {s.zScore.toFixed(2)}
      </span>
      {style.label ? (
        <span
          className={clsx(
            "rounded-[3px] px-[5px] font-mono text-[9.5px] uppercase tracking-[0.06em]",
            style.text,
          )}
        >
          {style.label}
        </span>
      ) : null}
    </div>
  );
}

export function MacroStrip({ signals }: { signals: MacroSignals }) {
  const ordered = signals.signals.slice().sort((a, b) => {
    const fa = FLAG_ORDER[a.flag];
    const fb = FLAG_ORDER[b.flag];
    if (fa !== fb) return fa - fb;
    return Math.abs(b.zScore) - Math.abs(a.zScore);
  });
  const extreme = signals.signals.filter((s) => s.flag === "extreme").length;
  const elevated = signals.signals.filter((s) => s.flag === "elevated").length;

  return (
    <section
      aria-label="Macro extremity signals"
      className="mb-4 rounded-[8px] border border-bd bg-panel px-4 py-3"
    >
      <header className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          § Macro extremity · z-score vs {signals.windowYears}y
        </h2>
        <span className="font-mono text-[10.5px] text-tx3">
          {extreme > 0 || elevated > 0
            ? `${extreme} extreme · ${elevated} elevated`
            : "nothing outside ±1σ"}
        </span>
        <span className="ml-auto font-mono text-[10px] text-tx3">
          updated {signals.generatedAt.slice(0, 16).replace("T", " ")}Z
        </span>
      </header>
      <div className="flex flex-wrap gap-2">
        {ordered.map((s) => (
          <Chip key={s.key} s={s} />
        ))}
      </div>
    </section>
  );
}
