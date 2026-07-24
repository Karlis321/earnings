import type { Freshness } from "./types";

// Fixture "today" — matches the PRD's data_updated timestamp.
export const TODAY_ISO = "2026-07-24";

// FreshnessDot RAG per PRD §9 / FE PRD §2.
// Compute at read time from as_of vs expected refresh window (days).
export function computeFreshness(
  asOfIso: string | null,
  now: string = TODAY_ISO,
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
