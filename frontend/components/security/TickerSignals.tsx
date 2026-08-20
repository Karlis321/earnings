"use client";

// TickerSignals — compact cross-reference strip on /s/[ticker].
// Surfaces every AI/data-derived signal the ticker has landed in
// this session's roadmap: ranking composite + rank, ideas AI pitch
// (if one was drafted), and framework screen scores (blue-ocean +
// rule-breaker) when the monthly workflow has covered the name.
//
// All fields are optional — the strip renders sub-panels only for
// the signals that exist. Zero-signal tickers get no strip at all.

import Link from "next/link";
import clsx from "clsx";
import { ArrowUp, ArrowDown, Minus, Quote } from "lucide-react";
import type {
  IdeaPitch,
  RankingHistoryRow,
  RankingRow,
  ScreenCard,
} from "@/lib/types";
import { CompositeSparkline } from "./CompositeSparkline";

interface Props {
  ticker: string;
  ranking: RankingRow | null;
  pitch: IdeaPitch | null;
  screens: {
    blueOcean: ScreenCard | null;
    ruleBreaker: ScreenCard | null;
  };
  // Phase 3.2 — 30-day composite history for this ticker. Empty
  // when data/ranking-history.jsonl doesn't exist yet or hasn't
  // accumulated enough rows for a sparkline (< 2 days).
  history?: RankingHistoryRow[];
}

function CompositeBadge({
  score,
  rank,
  href,
}: {
  score: number;
  rank: number;
  href: string;
}) {
  const positive = score >= 0;
  const Icon = positive ? ArrowUp : score === 0 ? Minus : ArrowDown;
  const color = positive
    ? "text-success-fg"
    : score === 0
    ? "text-tx-mid"
    : "text-danger";
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-[6px] border border-bd bg-panel2/60 px-3 py-1.5 text-[12px] hover:bg-hover"
      title="Composite score from the ranking leaderboard (reaction + surprise + trend)"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.07em] text-tx3">
        Rank
      </span>
      <span className="font-mono text-[11.5px] tabular-nums text-tx">
        #{rank}
      </span>
      <span aria-hidden className="text-tx3">
        ·
      </span>
      <Icon aria-hidden className={clsx("h-[11px] w-[11px]", color)} />
      <span className={clsx("font-mono text-[11.5px] tabular-nums", color)}>
        {positive ? "+" : ""}
        {score.toFixed(2)}
      </span>
    </Link>
  );
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

function PitchCard({ pitch }: { pitch: IdeaPitch }) {
  return (
    <article className="mt-2 rounded-[8px] border border-brand/30 bg-[rgba(47,127,255,0.04)] p-4">
      <header className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.07em] text-brand-fg">
        <Quote aria-hidden className="h-[11px] w-[11px]" />
        <span>AI thesis · from /ideas</span>
      </header>
      <p className="mb-2 text-[14px] font-semibold leading-[1.35] text-tx">
        {pitch.thesis}
      </p>
      <p className="mb-2 text-[12.5px] leading-[1.55] text-tx-mid">
        {pitch.rationale}
      </p>
      {pitch.risks.length > 0 ? (
        <div className="mb-2 text-[11.5px] leading-[1.5] text-tx-mid">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.07em] text-tx3">
            Risks:
          </span>{" "}
          {pitch.risks.join(" · ")}
        </div>
      ) : null}
      <div className="font-mono text-[10.5px] text-tx3">
        Catalyst: {pitch.catalyst.label}
        {pitch.catalyst.date ? ` · ${pitch.catalyst.date}` : ""}
      </div>
    </article>
  );
}

export function TickerSignals({
  ticker,
  ranking,
  pitch,
  screens,
  history,
}: Props) {
  const encodedTicker = encodeURIComponent(ticker);
  const hasAny =
    ranking ||
    pitch ||
    screens.blueOcean ||
    screens.ruleBreaker;
  if (!hasAny) return null;

  return (
    <section className="mt-4" aria-label="Cross-referenced AI signals">
      <div className="flex flex-wrap items-center gap-2">
        {ranking ? (
          <div className="flex items-center gap-1.5">
            <CompositeBadge
              score={ranking.compositeScore}
              rank={ranking.rank}
              href={`/ideas?ticker=${encodedTicker}`}
            />
            {history && history.length >= 2 ? (
              <CompositeSparkline history={history} />
            ) : null}
          </div>
        ) : null}
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
      </div>
      {pitch ? <PitchCard pitch={pitch} /> : null}
    </section>
  );
}
