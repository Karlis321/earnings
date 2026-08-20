"use client";

// Feature 4C — screen leaderboard. Sortable by composite; expandable
// rows show per-dimension scores + rationale + verdict + sources.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Star, StarOff } from "lucide-react";
import type {
  Screen,
  ScreenCard,
  ScreenDimensionScore,
  SharedState,
} from "@/lib/types";
import { TickerLogo } from "@/components/primitives/TickerLogo";

function ScoreBar({ score }: { score: number }) {
  // 0-100 rendered as a horizontal bar; color transitions at 50 (neutral) and 70 (strong).
  const color =
    score >= 70
      ? "bg-success"
      : score >= 50
      ? "bg-brand"
      : score >= 30
      ? "bg-[rgba(202,138,4,0.85)]"
      : "bg-danger";
  const text =
    score >= 70
      ? "text-success-fg"
      : score >= 50
      ? "text-brand-fg"
      : score >= 30
      ? "text-[rgba(202,138,4,1)]"
      : "text-danger";
  return (
    <span className="inline-flex items-center gap-2">
      <span className={clsx("w-[3rem] font-mono text-[11.5px] tabular-nums", text)}>
        {score.toFixed(0)}
      </span>
      <span className="relative inline-block h-[6px] w-[70px] rounded-full bg-s2">
        <span
          className={clsx("absolute left-0 top-0 h-full rounded-full", color)}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </span>
    </span>
  );
}

function DimensionRow({
  d,
  def,
}: {
  d: ScreenDimensionScore;
  def: { label: string; description?: string };
}) {
  return (
    <div className="grid grid-cols-[12rem_10rem_1fr] items-start gap-x-3 py-1 text-[12px]">
      <span
        className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-tx-mid"
        title={def.description}
      >
        {def.label}
      </span>
      <ScoreBar score={d.score} />
      <span className="text-tx-mid">{d.rationale}</span>
    </div>
  );
}

function Row({
  s,
  dimensions,
  expanded,
  onToggle,
  onOpen,
  highlighted,
  rowRef,
  inFocus,
  onToggleFocus,
  focusDisabled,
  focusFailed,
}: {
  s: ScreenCard;
  dimensions: Screen["dimensions"];
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  // True when this row is the deep-link target — gets a subtle
  // brand ring so the user's eye lands there after scroll.
  highlighted?: boolean;
  // Ref target for scroll-into-view. Undefined for non-highlighted
  // rows to avoid a per-row ref explosion.
  rowRef?: React.RefObject<HTMLDivElement | null>;
  inFocus: boolean;
  onToggleFocus: () => void;
  focusDisabled: boolean;
  focusFailed: boolean;
}) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <div
      ref={rowRef}
      className={clsx(
        "border-b border-bd/60",
        highlighted && "ring-2 ring-brand/40 bg-[rgba(47,127,255,0.04)]",
      )}
    >
      <div className="grid grid-cols-[2rem_2rem_2fr_10rem_2fr_5rem] items-center gap-x-3 px-3 py-2 hover:bg-hover">
        <button
          type="button"
          aria-pressed={inFocus}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFocus();
          }}
          disabled={focusDisabled}
          title={
            focusDisabled
              ? "Focus toggle unavailable"
              : inFocus
              ? "Remove from focus"
              : "Add to focus"
          }
          className={clsx(
            "flex h-5 w-5 items-center justify-center rounded-[3px] transition",
            inFocus
              ? "text-brand-fg hover:bg-hover"
              : "text-tx3 hover:text-tx-mid hover:bg-hover",
            focusDisabled && "cursor-not-allowed opacity-40",
            focusFailed && "text-danger",
          )}
        >
          {inFocus ? (
            <Star size={13} className="fill-current" />
          ) : (
            <StarOff size={13} />
          )}
        </button>
        <button
          onClick={onToggle}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="text-tx3 hover:text-tx"
        >
          <Icon size={14} />
        </button>
        <button
          onClick={onOpen}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <TickerLogo ticker={s.ticker} name={s.displayName} size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-tx">
              {s.displayName}
            </span>
            <span className="font-mono text-[10.5px] text-brand-fg">
              {s.ticker}
            </span>
          </span>
        </button>
        <ScoreBar score={s.compositeScore} />
        <span className="truncate text-[12px] leading-[1.5] text-tx-mid">
          {s.verdict}
        </span>
        <span className="text-right font-mono text-[10px] text-tx3">
          {s.screenedAt.slice(0, 10)}
        </span>
      </div>
      {expanded ? (
        <div className="border-t border-bd/40 bg-panel2/40 px-3 py-2">
          <div className="pl-[4.75rem]">
            {s.dimensions.map((d, i) => {
              const def = dimensions.find((x) => x.key === d.key);
              if (!def) return null;
              return (
                <DimensionRow
                  key={`${d.key}-${i}`}
                  d={d}
                  def={{ label: def.label, description: def.description }}
                />
              );
            })}
            <div className="mt-2 flex flex-wrap gap-1 text-[10.5px] text-tx3">
              <span className="font-mono uppercase tracking-[0.06em]">
                sources:
              </span>
              {s.sources.map((src, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-[3px] border border-bd bg-s2 px-[6px] py-[1px] font-mono"
                >
                  <span className="uppercase">{src.kind}</span>
                  <span>·</span>
                  <span className="max-w-[24ch] truncate">{src.ref}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ScreenTable({
  screen,
  highlightTicker,
  initialState,
}: {
  screen: Screen;
  // Deep-link target from ?ticker=. Row is auto-expanded on mount
  // + scrolled into view + ringed. Absent when the user reached
  // /screens via the nav tab rather than a TickerSignals badge.
  highlightTicker?: string | null;
  // Full shared-state for the focus-star toggle. Optional — when
  // absent, stars render disabled with a tooltip.
  initialState?: SharedState;
}) {
  const router = useRouter();
  const [focus, setFocus] = useState<Set<string>>(
    () => new Set(initialState?.preferences?.focusTickers ?? []),
  );
  const [failedFocus, setFailedFocus] = useState<string | null>(null);

  const toggleFocus = async (ticker: string) => {
    if (!initialState) return;
    const wasIn = focus.has(ticker);
    const nextFocus = new Set(focus);
    if (wasIn) nextFocus.delete(ticker);
    else nextFocus.add(ticker);
    setFocus(nextFocus);
    setFailedFocus(null);
    try {
      const nextState: SharedState = {
        ...initialState,
        preferences: initialState.preferences
          ? {
              ...initialState.preferences,
              focusTickers: Array.from(nextFocus),
            }
          : {
              focusTickers: Array.from(nextFocus),
              themes: initialState.themes ?? [],
              subscriptions: {
                newTranscripts: false,
                weekAhead: false,
                ideasDigest: false,
              },
            },
      };
      const r = await fetch("/api/shared-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextState),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message ?? `HTTP ${r.status}`);
      }
    } catch {
      setFocus((prev) => {
        const rb = new Set(prev);
        if (wasIn) rb.add(ticker);
        else rb.delete(ticker);
        return rb;
      });
      setFailedFocus(ticker);
    }
  };
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Seed the expansion set with the highlight ticker so the
    // dimension breakdown is visible on first paint (no
    // click-then-expand friction).
    return highlightTicker ? new Set([highlightTicker]) : new Set();
  });
  const [minScore, setMinScore] = useState<number>(0);
  const [query, setQuery] = useState("");
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Scroll the highlight row into view once after mount + after
  // filter/sort resolves. Behavior:smooth so the transition is
  // visible; block:center so the row lands roughly in the middle
  // of the viewport (users see the row + a couple neighbors for
  // context).
  useEffect(() => {
    if (!highlightTicker) return;
    if (!highlightRef.current) return;
    highlightRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [highlightTicker]);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return screen.screens
      .filter((s) => s.compositeScore >= minScore)
      .filter((s) => {
        if (!term) return true;
        return (
          s.ticker.toLowerCase().includes(term) ||
          s.displayName.toLowerCase().includes(term)
        );
      })
      .slice()
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }, [screen.screens, minScore, query]);

  const toggle = (t: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-button border border-bd bg-s1 px-2 py-[3px] text-[12px]">
          <span className="text-tx-mid">Min composite</span>
          {[0, 50, 70].map((v) => (
            <button
              key={v}
              onClick={() => setMinScore(v)}
              className={clsx(
                "rounded-[4px] px-[7px] py-[2px] font-mono text-[11px]",
                minScore === v
                  ? "bg-s3 text-tx"
                  : "text-tx-mid hover:text-tx",
              )}
            >
              {v === 0 ? "any" : `≥ ${v}`}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by ticker or name…"
          className="h-9 min-w-[240px] rounded-button border border-bd bg-s1 px-3 text-[13px] text-tx placeholder:text-tx3 focus:border-brand focus:outline-none"
        />
        <span className="ml-auto font-mono text-[11px] text-tx3">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="rounded-[8px] border border-bd bg-panel">
        <div className="grid grid-cols-[2rem_2rem_2fr_10rem_2fr_5rem] gap-x-3 border-b border-bd px-3 py-2 font-mono text-[10px] uppercase tracking-[0.07em] text-tx3">
          <span />
          <span />
          <span>Company</span>
          <span>Composite</span>
          <span>Verdict</span>
          <span className="text-right">Screened</span>
        </div>
        {rows.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-tx-mid">
            No rows match the current filters.
          </div>
        ) : (
          rows.map((s) => (
            <Row
              key={s.ticker}
              s={s}
              dimensions={screen.dimensions}
              expanded={expanded.has(s.ticker)}
              onToggle={() => toggle(s.ticker)}
              onOpen={() =>
                router.push(`/s/${encodeURIComponent(s.ticker)}`)
              }
              highlighted={highlightTicker === s.ticker}
              rowRef={
                highlightTicker === s.ticker ? highlightRef : undefined
              }
              inFocus={focus.has(s.ticker)}
              onToggleFocus={() => toggleFocus(s.ticker)}
              focusDisabled={!initialState}
              focusFailed={failedFocus === s.ticker}
            />
          ))
        )}
      </div>
    </>
  );
}
