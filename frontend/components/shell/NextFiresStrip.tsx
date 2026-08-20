"use client";

// Compact strip showing when the AI-writing workflows fire next.
// Computed client-side so "in 2d 3h" ticks down live between
// visits. Rendered on the overview page + settings so users have
// a mental model of when new data lands.
//
// Cadence source of truth: .github/workflows/*.yml cron expressions.
// If any of those changes, update WORKFLOWS below.

import { useEffect, useState } from "react";

type Kind = "ideas" | "week-ahead" | "blue-ocean" | "rule-breaker";

interface Workflow {
  kind: Kind;
  label: string;
  href: string;
  // Returns the next fire time (UTC) at or after `from`.
  next(from: Date): Date;
}

// Weekday helper — cron day-of-week: 0=Sun, 1=Mon, ..., 6=Sat.
function nextWeekday(
  from: Date,
  weekdays: number[],
  hourUtc: number,
): Date {
  // Sort ascending so we can pick the earliest future match.
  const days = [...weekdays].sort();
  const candidate = new Date(from);
  for (let i = 0; i < 14; i++) {
    const d = candidate.getUTCDay();
    if (days.includes(d)) {
      const fireToday = new Date(candidate);
      fireToday.setUTCHours(hourUtc, 0, 0, 0);
      if (fireToday.getTime() > from.getTime()) return fireToday;
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  // Shouldn't happen unless the cadence is broken.
  return new Date(from.getTime() + 7 * 86_400_000);
}

// Monthly helper — cron day-of-month at hourUtc.
function nextMonthly(from: Date, dayOfMonth: number, hourUtc: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, dayOfMonth, hourUtc, 0, 0));
  if (thisMonth.getTime() > from.getTime()) return thisMonth;
  return new Date(Date.UTC(y, m + 1, dayOfMonth, hourUtc, 0, 0));
}

const WORKFLOWS: Workflow[] = [
  {
    kind: "ideas",
    label: "Ideas",
    href: "/ideas",
    // Mon / Wed / Fri at 14:00 UTC.
    next: (from) => nextWeekday(from, [1, 3, 5], 14),
  },
  {
    kind: "week-ahead",
    label: "Week ahead",
    href: "/week-ahead",
    // Sunday 22:00 UTC.
    next: (from) => nextWeekday(from, [0], 22),
  },
  {
    kind: "blue-ocean",
    label: "Blue Ocean",
    href: "/screens?framework=blue-ocean",
    // 1st of month · 12:00 UTC.
    next: (from) => nextMonthly(from, 1, 12),
  },
  {
    kind: "rule-breaker",
    label: "Rule Breaker",
    href: "/screens?framework=rule-breaker",
    // 2nd of month · 12:00 UTC.
    next: (from) => nextMonthly(from, 2, 12),
  },
];

function humanDelta(ms: number): string {
  if (ms < 0) return "now";
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (ms < 90 * min) return `${Math.floor(ms / min)}m`;
  if (ms < 48 * hr) {
    const h = Math.floor(ms / hr);
    const m = Math.floor((ms % hr) / min);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / day);
  const h = Math.floor((ms % day) / hr);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function NextFiresStrip() {
  // Tick every 60s so the countdown feels live but doesn't churn.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[8px] border border-dashed border-bd bg-panel2/40 px-4 py-2 text-[11.5px] text-tx-mid">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.07em] text-tx3">
        Next fires
      </span>
      {WORKFLOWS.map((w) => {
        const next = w.next(now);
        const delta = next.getTime() - now.getTime();
        return (
          <a
            key={w.kind}
            href={w.href}
            className="inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-[1px] hover:bg-hover"
            title={`Next scheduled: ${next.toISOString().slice(0, 16).replace("T", " ")}Z`}
          >
            <span className="text-tx">{w.label}</span>
            <span className="font-mono text-[10.5px] text-brand-fg tabular-nums">
              in {humanDelta(delta)}
            </span>
          </a>
        );
      })}
    </div>
  );
}
