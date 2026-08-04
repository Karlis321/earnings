"use client";

// One popover to consolidate all watchlist "how do I want this
// list arranged" controls: ordering (was Sort + Group), cap
// tier, reporting-soon toggle, listings toggle. The main
// filter bar keeps only the sector/index tabs (portfolio,
// SP500, R1000, tech, etc.) as primary navigation; everything
// else lives behind this Filter button.

import * as Popover from "@radix-ui/react-popover";
import { SlidersHorizontal, X } from "lucide-react";
import clsx from "clsx";

type SortKey =
  | "cap"
  | "cap-asc"
  | "winners-1m"
  | "losers-1m"
  | "next"
  | "surprise"
  | "reaction"
  | "freshness"
  | "name";

type Group = "flat" | "type" | "sector" | "industry" | "cap-industry";

type TierFilter = "any" | "mega" | "large" | "mid" | "small" | "unknown";

interface Props {
  sortKey: SortKey;
  setSortKey: (s: SortKey) => void;
  group: Group;
  setGroup: (g: Group) => void;
  tier: TierFilter;
  setTier: (t: TierFilter) => void;
  reportingSoon: boolean;
  setReportingSoon: (v: boolean) => void;
  showAllListings: boolean;
  setShowAllListings: (v: boolean) => void;
}

const SORT_OPTIONS: Array<{ id: SortKey; label: string }> = [
  { id: "cap", label: "Market cap · high → low" },
  { id: "cap-asc", label: "Market cap · low → high" },
  { id: "winners-1m", label: "Biggest winners · 1M" },
  { id: "losers-1m", label: "Biggest losers · 1M" },
  { id: "next", label: "Next report date" },
  { id: "surprise", label: "Last EPS surprise · latest quarter" },
  { id: "reaction", label: "1-day reaction post-earnings" },
  { id: "freshness", label: "Freshness" },
  { id: "name", label: "Name (A → Z)" },
];

const GROUP_OPTIONS: Array<{ id: Group; label: string }> = [
  { id: "flat", label: "None (flat list)" },
  { id: "type", label: "By security type" },
  { id: "sector", label: "By sector" },
  { id: "industry", label: "By industry" },
  { id: "cap-industry", label: "By cap band × industry" },
];

const TIER_OPTIONS: Array<{ id: TierFilter; label: string }> = [
  { id: "any", label: "Any" },
  { id: "mega", label: "Mega ≥$200B" },
  { id: "large", label: "Large $10B–$200B" },
  { id: "mid", label: "Mid $2B–$10B" },
  { id: "small", label: "Small $250M–$2B" },
  { id: "unknown", label: "Nano / n/a" },
];

export function WatchlistFilterPopover(props: Props) {
  const {
    sortKey, setSortKey,
    group, setGroup,
    tier, setTier,
    reportingSoon, setReportingSoon,
    showAllListings, setShowAllListings,
  } = props;

  // Show a small "active" dot when non-default filters are set.
  const isActive =
    sortKey !== "cap" ||
    group !== "flat" ||
    tier !== "any" ||
    reportingSoon ||
    showAllListings;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={clsx(
            "inline-flex h-8 items-center gap-2 rounded-button border px-3 text-[12.5px] transition-colors",
            isActive
              ? "border-brand bg-brand/10 text-brand-fg"
              : "border-bd bg-s1 text-tx2 hover:text-tx",
          )}
        >
          <SlidersHorizontal size={13} aria-hidden />
          <span>Filter</span>
          {isActive ? (
            <span className="h-[6px] w-[6px] rounded-full bg-brand" aria-hidden />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[340px] rounded-panel border border-bd2 bg-s1 p-4 shadow-[var(--sh-popover)]"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
              Filter · Sort · Group
            </span>
            <Popover.Close asChild>
              <button className="rounded-[4px] p-1 text-tx3 hover:bg-hover hover:text-tx" aria-label="Close">
                <X size={13} />
              </button>
            </Popover.Close>
          </div>

          {/* Sort */}
          <div className="mb-4">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.07em] text-tx-mid">
              Sort by
            </label>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-8 w-full rounded-button border border-bd bg-s2 px-2 text-[12.5px] text-tx"
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* Group */}
          <div className="mb-4">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.07em] text-tx-mid">
              Group by
            </label>
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value as Group)}
              className="h-8 w-full rounded-button border border-bd bg-s2 px-2 text-[12.5px] text-tx"
            >
              {GROUP_OPTIONS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>

          {/* Cap tier chips */}
          <div className="mb-4">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.07em] text-tx-mid">
              Cap tier
            </label>
            <div className="flex flex-wrap gap-[6px]">
              {TIER_OPTIONS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTier(t.id)}
                  className={
                    tier === t.id
                      ? "inline-flex h-[24px] items-center rounded-[5px] border border-brand bg-brand/10 px-[9px] text-[11px] text-brand-fg"
                      : "inline-flex h-[24px] items-center rounded-[5px] border border-bd2 bg-s2 px-[9px] text-[11px] text-tx2 hover:text-tx"
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Toggles */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[12.5px] text-tx">
              <input
                type="checkbox"
                checked={reportingSoon}
                onChange={(e) => setReportingSoon(e.target.checked)}
                className="h-[14px] w-[14px] rounded-[3px] accent-brand"
              />
              <span>Reporting soon (≤ 14 days)</span>
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-tx">
              <input
                type="checkbox"
                checked={showAllListings}
                onChange={(e) => setShowAllListings(e.target.checked)}
                className="h-[14px] w-[14px] rounded-[3px] accent-brand"
              />
              <span title="Show every listing including BDR / ADR / GY wrappers. NVIDIA appears once, not four times when off.">
                Show all listings (default: canonical only)
              </span>
            </label>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
