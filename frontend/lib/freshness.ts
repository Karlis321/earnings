import type { Freshness } from "./types";

// Real system today, evaluated fresh at every render. RSC renders with
// server-local date; client re-hydrates with browser date — same UTC day
// in every practical case (mismatches only around midnight UTC and only
// briefly, well within acceptable hydration tolerance).
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Legacy alias kept for a soft migration; new code should call todayIso()
// directly since the value moves every day.
/** @deprecated call `todayIso()` — the fixture pin was fine for the
 * design phase but a snapshot dashboard needs the real system date. */
export const TODAY_ISO_LEGACY_FIXTURE = "2026-07-24";

// FreshnessDot RAG per PRD §9 / FE PRD §2.
// Compute at read time from as_of vs expected refresh window (days).
export function computeFreshness(
  asOfIso: string | null,
  now: string = todayIso(),
  expectedRefreshDays: number = 1,
): Freshness {
  if (!asOfIso) return "never";
  const asOf = new Date(asOfIso).getTime();
  const nowMs = new Date(now).getTime();
  const days = (nowMs - asOf) / 86400000;
  if (days <= expectedRefreshDays) return "fresh";
  if (days <= expectedRefreshDays * 5) return "overdue";
  return "stale";
}

/** Days between two ISO dates (positive if `to` is later than `from`). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000,
  );
}

/** Days from today until an ISO date (positive = future). */
export function daysUntil(iso: string): number {
  return daysBetween(todayIso(), iso);
}

export function freshnessLabel(f: Freshness): string {
  return {
    fresh: "Fresh · within expected refresh",
    overdue: "Overdue · past expected window",
    stale: "Stale · fetch failing",
    never: "Never fetched",
  }[f];
}

export function freshnessColor(f: Freshness): string {
  return {
    fresh: "var(--success)",
    overdue: "var(--warning)",
    stale: "var(--danger)",
    never: "#4b5563",
  }[f];
}
