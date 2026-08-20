"use client";

// Week Ahead grid — renders upcoming earnings events grouped by day,
// with focus tickers highlighted at the top of each day's list.
// Composite score (from ranking.json when available) shown as a
// small divergent bar; rows without ranking data show ticker + last
// surprise + period only.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowUp, ArrowDown } from "lucide-react";
import { TickerLogo } from "@/components/primitives/TickerLogo";

export interface WeekAheadRow {
  ticker: string;
  displayName: string;
  capTier: string;
  marketCapUsd: number | null;
  period: string;
  scheduledDate: string; // ISO YYYY-MM-DD
  isEstimated: boolean;
  cadence?: string;
  lastPeriod: string | null;
  lastSurprisePct: number | null;
  compositeScore: number | null;
  compositeRank: number | null;
  isFocus: boolean;
}

interface Props {
  rows: WeekAheadRow[];
  horizonStart: string;
  horizonEnd: string;
  // Deep-link ticker highlight from ?ticker=. Row gets a brand ring
  // + smooth-scroll to viewport center on mount. Absent for
  // vanilla nav-tab arrivals.
  highlightTicker?: string | null;
}

const DAY_LABEL: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

function dayLabel(iso: string): string {
  // Parse as UTC midnight so day-of-week matches ISO calendar.
  const d = new Date(iso + "T00:00:00Z");
  return DAY_LABEL[d.getUTCDay()];
}

function fmtDayHeader(iso: string, today: string): string {
  if (iso === today) return `Today · ${dayLabel(iso)} ${iso.slice(5)}`;
  const t = new Date(today + "T00:00:00Z").getTime();
  const d = new Date(iso + "T00:00:00Z").getTime();
  const dayDiff = Math.round((d - t) / 86_400_000);
  if (dayDiff === 1) return `Tomorrow · ${dayLabel(iso)} ${iso.slice(5)}`;
  return `${dayLabel(iso)} · ${iso}`;
}

function CompositeSpark({ score }: { score: number | null }) {
  if (score == null) {
    return <span className="text-tx3 text-[10.5px]">—</span>;
  }
  const positive = score >= 0;
  const pct = Math.min(100, Math.abs(score) * 100);
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={clsx(
          "font-mono text-[10.5px] tabular-nums",
          positive ? "text-success-fg" : "text-danger",
        )}
      >
        {positive ? "+" : ""}
        {score.toFixed(2)}
      </span>
      <span className="relative inline-block h-[4px] w-[36px] rounded-full bg-s2">
        <span
          className={clsx(
            "absolute top-0 h-full rounded-full",
            positive ? "left-1/2 bg-success" : "right-1/2 bg-danger",
          )}
          style={{ width: `${pct / 2}%` }}
        />
        <span className="absolute left-1/2 top-[-1px] h-[6px] w-[1px] bg-bd" />
      </span>
    </span>
  );
}

function SurpriseCell({ pct }: { pct: number | null }) {
  if (pct == null || Number.isNaN(pct)) {
    return <span className="text-tx3 text-[10.5px]">—</span>;
  }
  const up = pct >= 0;
  const Icon = up ? ArrowUp : ArrowDown;
  const color = up ? "text-success-fg" : "text-danger";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-[3px] font-mono text-[10.5px] tabular-nums",
        color,
      )}
    >
      <Icon aria-hidden className="h-[9px] w-[9px]" />
      {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function Row({
  r,
  onClick,
  highlighted,
  rowRef,
}: {
  r: WeekAheadRow;
  onClick: () => void;
  highlighted?: boolean;
  rowRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={rowRef}
      onClick={onClick}
      className={clsx(
        "grid w-full grid-cols-[2.5rem_2fr_5.5rem_6rem_5.5rem_5.5rem] items-center gap-x-3 border-b border-bd/50 px-3 py-2 text-left text-[13px] hover:bg-hover",
        r.isFocus && "bg-[rgba(47,127,255,0.04)]",
        highlighted && "ring-2 ring-brand/40 bg-[rgba(47,127,255,0.06)]",
      )}
    >
      <span className="flex items-center gap-1">
        <TickerLogo ticker={r.ticker} name={r.displayName} size={22} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-tx">{r.displayName}</span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-tx-mid">
          <span className="text-brand-fg">{r.ticker}</span>
          {r.isFocus ? (
            <span
              className="rounded-[3px] border border-brand/40 bg-brand/10 px-[4px] text-[8.5px] uppercase tracking-[0.06em] text-brand-fg"
              title="On your focus list"
            >
              focus
            </span>
          ) : null}
          {r.compositeRank != null ? (
            <span className="text-tx3">#{r.compositeRank}</span>
          ) : null}
        </span>
      </span>
      <span className="font-mono text-[10.5px] uppercase text-tx-mid">
        {r.period}
      </span>
      <CompositeSpark score={r.compositeScore} />
      <SurpriseCell pct={r.lastSurprisePct} />
      <span className="text-right font-mono text-[10px] uppercase tracking-[0.06em] text-tx3">
        {r.capTier === "unknown" ? "—" : r.capTier}
      </span>
    </button>
  );
}

export function WeekAheadGrid({
  rows,
  horizonStart,
  highlightTicker,
}: Props) {
  const router = useRouter();
  const [focusOnly, setFocusOnly] = useState(false);
  const [minComposite, setMinComposite] = useState<number | null>(null);
  const highlightRef = useRef<HTMLButtonElement | null>(null);

  // Scroll to the deep-link target once after mount + after
  // filter/sort resolves. behavior:smooth + block:center matches
  // /ideas + /screens deep-link pattern for a consistent affordance.
  useEffect(() => {
    if (!highlightTicker) return;
    if (!highlightRef.current) return;
    highlightRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [highlightTicker]);

  const filtered = useMemo(() => {
    return rows
      .filter((r) => (!focusOnly ? true : r.isFocus))
      .filter((r) =>
        minComposite == null
          ? true
          : (r.compositeScore ?? -1) >= minComposite,
      );
  }, [rows, focusOnly, minComposite]);

  const grouped = useMemo(() => {
    const m = new Map<string, WeekAheadRow[]>();
    for (const r of filtered) {
      if (!m.has(r.scheduledDate)) m.set(r.scheduledDate, []);
      m.get(r.scheduledDate)!.push(r);
    }
    // Sort each day's rows: focus first, then by composite desc,
    // then by cap tier, then by ticker.
    const capOrder: Record<string, number> = {
      mega: 0,
      large: 1,
      mid: 2,
      small: 3,
      unknown: 4,
    };
    for (const list of m.values()) {
      list.sort((a, b) => {
        if (a.isFocus !== b.isFocus) return a.isFocus ? -1 : 1;
        const ca = a.compositeScore;
        const cb = b.compositeScore;
        if (ca != null && cb != null && ca !== cb) return cb - ca;
        if (ca != null && cb == null) return -1;
        if (cb != null && ca == null) return 1;
        const oa = capOrder[a.capTier] ?? 5;
        const ob = capOrder[b.capTier] ?? 5;
        if (oa !== ob) return oa - ob;
        return a.ticker.localeCompare(b.ticker);
      });
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const focusCount = rows.filter((r) => r.isFocus).length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {focusCount > 0 ? (
          <button
            onClick={() => setFocusOnly((v) => !v)}
            className={clsx(
              "rounded-button border px-3 py-[6px] text-[12.5px]",
              focusOnly
                ? "border-brand bg-[rgba(47,127,255,0.10)] text-brand-fg"
                : "border-bd bg-s1 text-tx-mid hover:text-tx",
            )}
          >
            {focusOnly ? "Focus only ✓" : "Focus only"}
          </button>
        ) : null}
        <div className="flex items-center gap-2 rounded-button border border-bd bg-s1 px-2 py-[3px] text-[12px]">
          <span className="text-tx-mid">Min composite</span>
          {[null, 0, 0.5].map((v, i) => (
            <button
              key={i}
              onClick={() => setMinComposite(v)}
              className={clsx(
                "rounded-[4px] px-[7px] py-[2px] font-mono text-[11px]",
                minComposite === v
                  ? "bg-s3 text-tx"
                  : "text-tx-mid hover:text-tx",
              )}
            >
              {v == null ? "any" : v === 0 ? "≥ 0" : "≥ +0.5"}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-tx3">
          {filtered.length} of {rows.length} rows
        </span>
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-[8px] border border-bd bg-panel p-8 text-center text-[13px] text-tx-mid">
          No events match the current filters.
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([date, list]) => (
            <section
              key={date}
              aria-labelledby={`day-${date}`}
              className="rounded-[8px] border border-bd bg-panel"
            >
              <header
                id={`day-${date}`}
                className="flex items-center justify-between border-b border-bd px-4 py-2"
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.07em] text-tx">
                  {fmtDayHeader(date, horizonStart)}
                </span>
                <span className="font-mono text-[10.5px] text-tx3">
                  {list.length} event{list.length === 1 ? "" : "s"}
                </span>
              </header>
              <div className="grid grid-cols-[2.5rem_2fr_5.5rem_6rem_5.5rem_5.5rem] gap-x-3 border-b border-bd px-3 py-1 font-mono text-[9.5px] uppercase tracking-[0.07em] text-tx3">
                <span />
                <span>Name</span>
                <span>Period</span>
                <span>Composite</span>
                <span>Last Δ</span>
                <span className="text-right">Cap</span>
              </div>
              {list.map((r) => (
                <Row
                  key={r.ticker}
                  r={r}
                  onClick={() => router.push(`/s/${encodeURIComponent(r.ticker)}`)}
                  highlighted={highlightTicker === r.ticker}
                  rowRef={
                    highlightTicker === r.ticker ? highlightRef : undefined
                  }
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
