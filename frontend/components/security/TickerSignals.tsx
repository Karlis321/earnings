"use client";

// TickerSignals — compact cross-reference strip on /s/[ticker].
// Surfaces the framework-screen scores (blue-ocean, rule-breaker,
// qarv) when the monthly workflow / mechanical screen has covered
// the name. Ranking + Ideas signals were removed after the pivot
// to sector-level themes; use /themes for that view instead.
//
// Renders nothing when the ticker has no framework coverage.

import Link from "next/link";
import clsx from "clsx";
import type { ScreenCard } from "@/lib/types";

interface Props {
  ticker: string;
  screens: {
    blueOcean: ScreenCard | null;
    ruleBreaker: ScreenCard | null;
    qarv?: ScreenCard | null;
  };
}

function FrameworkBadge({
  label,
  card,
  href,
}: {
  label: string;
  card: ScreenCard | null;
  href: string;
}) {
  if (!card) return null;
  const s = card.compositeScore;
  const color =
    s >= 70
      ? "text-success-fg"
      : s >= 50
      ? "text-brand-fg"
      : s >= 30
      ? "text-[rgba(202,138,4,1)]"
      : "text-danger";
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-[6px] border border-bd bg-panel2/60 px-3 py-1.5 text-[12px] hover:bg-hover"
      title={card.verdict}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.07em] text-tx3">
        {label}
      </span>
      <span className={clsx("font-mono text-[11.5px] tabular-nums", color)}>
        {s.toFixed(0)}
      </span>
    </Link>
  );
}

export function TickerSignals({ ticker, screens }: Props) {
  const encodedTicker = encodeURIComponent(ticker);
  const hasAny = screens.blueOcean || screens.ruleBreaker || screens.qarv;
  if (!hasAny) return null;

  return (
    <section className="mt-4" aria-label="Cross-referenced framework signals">
      <div className="flex flex-wrap items-center gap-2">
        <FrameworkBadge
          label="Blue Ocean"
          card={screens.blueOcean}
          href={`/screens?framework=blue-ocean&ticker=${encodedTicker}`}
        />
        <FrameworkBadge
          label="Rule Breaker"
          card={screens.ruleBreaker}
          href={`/screens?framework=rule-breaker&ticker=${encodedTicker}`}
        />
        <FrameworkBadge
          label="QARV"
          card={screens.qarv ?? null}
          href={`/screens?framework=qarv&ticker=${encodedTicker}`}
        />
      </div>
    </section>
  );
}
