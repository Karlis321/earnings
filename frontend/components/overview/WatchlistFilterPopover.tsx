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

type FixedSortKey =
  | "cap"
  | "cap-asc"
  | "winners-1m"
  | "losers-1m"
  | "next"
  | "surprise"
  | "surprise-rev"
  | "reaction"
  | "reaction-d3"
  | "reaction-d3-excess"
  | "reaction-w1"
  | "reaction-m1"
  | "reaction-loss"
  | "reaction-loss-d3"
  | "reaction-loss-w1"
  | "reaction-loss-m1"
  | "freshness"
  | "name";
type SortKey = FixedSortKey | `metric:${string}:${"value" | "surprise"}:${"desc" | "asc"}`;

type Group =
  | "flat"
  | "type"
  | "sector"
  | "industry"
  | "cap-industry"
  | "cap-band-desc"
  | "cap-band-asc";

type TierFilter = "any" | "mega" | "large" | "mid" | "small" | "unknown";

interface AvailableMetric {
  key: string;
  label: string;
  unit: string | null;
  count: number;
  surpriseCount?: number;
}

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
  availableMetrics?: AvailableMetric[];
}

// Grouped sort options. Optgroups render as separators in the
// native <select>. Keys are the internal SortKey values.
const SORT_GROUPS: Array<{
  label: string;
  options: Array<{ id: SortKey; label: string }>;
}> = [
  {
    label: "By size",
    options: [
      { id: "cap", label: "Market cap · high → low" },
      { id: "cap-asc", label: "Market cap · low → high" },
    ],
  },
  {
    label: "By price change (1-month sparkline)",
    options: [
      { id: "winners-1m", label: "Biggest winners · 1M price" },
      { id: "losers-1m", label: "Biggest losers · 1M price" },
    ],
  },
  {
    label: "By reaction to last earnings (winners)",
    options: [
      { id: "reaction", label: "d1 · 1 trading day after report" },
      { id: "reaction-d3", label: "d3 · 3 trading days after" },
      { id: "reaction-w1", label: "w1 · 1 week after" },
      { id: "reaction-m1", label: "m1 · 1 month after" },
    ],
  },
  {
    label: "By reaction to last earnings (losers)",
    options: [
      { id: "reaction-loss", label: "d1 · biggest 1-day drops" },
      { id: "reaction-loss-d3", label: "d3 · biggest 3-day drops" },
      { id: "reaction-loss-w1", label: "w1 · biggest 1-week drops" },
      { id: "reaction-loss-m1", label: "m1 · biggest 1-month drops" },
    ],
  },
  {
    label: "By earnings surprise",
    options: [
      { id: "surprise", label: "EPS beat/miss · latest quarter" },
      { id: "surprise-rev", label: "Revenue beat/miss · latest quarter" },
    ],
  },
  {
    label: "By calendar",
    options: [
      { id: "next", label: "Next report date · nearest first" },
      { id: "freshness", label: "Data freshness" },
    ],
  },
  {
    label: "Alphabetical",
    options: [{ id: "name", label: "Name (A → Z)" }],
  },
];

const SORT_OPTIONS = SORT_GROUPS.flatMap((g) => g.options);

const GROUP_OPTIONS: Array<{ id: Group; label: string }> = [
  { id: "flat", label: "None (flat list)" },
  { id: "cap-band-desc", label: "By cap band · high → low" },
  { id: "cap-band-asc", label: "By cap band · low → high" },
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
    availableMetrics = [],
  } = props;

  // Detect if current sort is a metric-sort so we can render the
  // dynamic controls in that section instead of the fixed dropdown.
  const isMetricSort = sortKey.startsWith("metric:");
  const [metricKey, metricDim, metricDir] = isMetricSort
    ? sortKey.split(":").slice(1)
    : ["", "value", "desc"];

  // Selected metric's surprise-population count. Used to warn the
  // user + block a no-op sort when they pick a metric whose surprise
  // dim is universally null (same-basis rule cleared everything).
  const selectedMetric = availableMetrics.find((m) => m.key === metricKey);
  const surpriseSelectable = (selectedMetric?.surpriseCount ?? 0) > 0;

  // Hide fixed "Revenue beat/miss" sort when 0 rows have revenue
  // surprise% populated. The same-basis rule clears cross-basis
  // triples at ingest, and today no revenue metrics survive the
  // filter — the sort would be a silent no-op. EPS survives (~111
  // tickers) so the EPS beat/miss option stays.
  const revenueSurpriseCount =
    availableMetrics.find((m) => /^revenues?_/.test(m.key))?.surpriseCount ?? 0;
  const epsSurpriseCount =
    availableMetrics.find((m) => /^eps(_|$)/.test(m.key))?.surpriseCount ?? 0;
  const visibleSortGroups = SORT_GROUPS.map((g) => ({
    ...g,
    options: g.options.filter((o) => {
      if (o.id === "surprise-rev" && revenueSurpriseCount === 0) return false;
      if (o.id === "surprise" && epsSurpriseCount === 0) return false;
      return true;
    }),
  })).filter((g) => g.options.length > 0);

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

          {/* Sort — grouped by category (size, price, reaction winners,
              reaction losers, surprise, calendar, alphabetical). */}
          <div className="mb-4">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.07em] text-tx-mid">
              Sort by
            </label>
            <select
              value={isMetricSort ? "" : sortKey}
              onChange={(e) => {
                if (e.target.value) setSortKey(e.target.value as SortKey);
              }}
              className="h-8 w-full rounded-button border border-bd bg-s2 px-2 text-[12.5px] text-tx"
            >
              {isMetricSort ? <option value="">(sorting by specific metric ↓)</option> : null}
              {visibleSortGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Sort by a specific metric present on visible rows.
              Dynamic — populated from availableMetrics prop by the
              parent's useMemo over currently-filtered rows. Empty when
              no rows have any metrics (rare — usually devs / ETFs
              only). Two selectors + direction toggle. */}
          {availableMetrics.length > 0 ? (
            <div className="mb-4 rounded-[6px] border border-bd bg-s2/60 p-2.5">
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.07em] text-tx-mid">
                Or · sort by specific metric
              </label>
              <div className="flex gap-2">
                <select
                  value={metricKey}
                  onChange={(e) => {
                    const k = e.target.value;
                    if (!k) return;
                    setSortKey(`metric:${k}:${metricDim as "value" | "surprise"}:${metricDir as "desc" | "asc"}`);
                  }}
                  className="h-8 flex-1 rounded-button border border-bd bg-s1 px-2 text-[12px] text-tx"
                >
                  <option value="">— select metric —</option>
                  {availableMetrics.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label} ({m.count})
                    </option>
                  ))}
                </select>
              </div>
              {isMetricSort && metricKey ? (
                <div className="mt-2 flex gap-2">
                  <select
                    value={metricDim}
                    onChange={(e) => {
                      const dim = e.target.value as "value" | "surprise";
                      // Guard: don't switch to surprise if the metric
                      // has no surprise% data (same-basis rule cleared
                      // everything). Would produce a silent no-op sort.
                      if (dim === "surprise" && !surpriseSelectable) return;
                      setSortKey(`metric:${metricKey}:${dim}:${metricDir as "desc" | "asc"}`);
                    }}
                    className="h-8 flex-1 rounded-button border border-bd bg-s1 px-2 text-[12px] text-tx"
                  >
                    <option value="value">Value (actual reported)</option>
                    <option value="surprise" disabled={!surpriseSelectable}>
                      Surprise vs estimate{surpriseSelectable ? "" : " · no data"}
                    </option>
                  </select>
                  <select
                    value={metricDir}
                    onChange={(e) =>
                      setSortKey(
                        `metric:${metricKey}:${metricDim as "value" | "surprise"}:${e.target.value as "desc" | "asc"}`,
                      )
                    }
                    className="h-8 flex-1 rounded-button border border-bd bg-s1 px-2 text-[12px] text-tx"
                  >
                    <option value="desc">High → low</option>
                    <option value="asc">Low → high</option>
                  </select>
                </div>
              ) : null}
              <p className="mt-1.5 text-[10.5px] leading-[1.4] text-tx3">
                Only metrics present on visible rows appear. The count is how many rows have this metric on their latest reported event.
              </p>
            </div>
          ) : null}

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
