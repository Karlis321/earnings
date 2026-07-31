"use client";

// The analyst home screen — dense sortable type-aware table.
// Filter/sort bar per FE PRD §7.2 (P4-T2).
// Row states: recent-event highlight, data-incomplete, unscheduled (P4-T3).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { WatchlistRow, SecurityType } from "@/lib/types";
import {
  SurprisePill,
  GuidanceMoveBadge,
  FreshnessDot,
  StalenessLegend,
  ReactionRow,
} from "@/components/primitives";
import { TickerLogo } from "@/components/primitives/TickerLogo";
import {
  RealPriceSparkline,
  PriceDeltaLabel,
} from "./RealPriceSparkline";
import { fmtDaysUntil, fmtDateShort } from "@/lib/format";
import { daysUntil as daysUntilFn } from "@/lib/freshness";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import clsx from "clsx";

// Server response shape from /api/prices/bulk
interface BulkPriceEntry {
  ok: boolean;
  series: { date: string; close: number }[];
  pctChange?: number;
  latest?: number;
  first?: number;
  change?: number;
  err?: string;
}
interface BulkPricesResponse {
  range: string;
  fetchedAt: string;
  tickers: Record<string, BulkPriceEntry>;
}

interface BulkEarningsEntry {
  ok: boolean;
  data?: {
    nextEarningsDate: string | null;
    lastQuarter: {
      period: string;
      actual: number | null;
      estimate: number | null;
      surprisePct: number | null;
    } | null;
  };
  err?: string;
}
interface BulkEarningsResponse {
  fetchedAt: string;
  tickers: Record<string, BulkEarningsEntry>;
}

// Industry buckets — sectorTag → industry group. The registry tags are
// a mix of Yahoo-screener top-level names ("technology", "materials",
// "healthcare", "financial-services", ...) and older fine-grained tags
// from the manual portfolio setup ("copper", "gold", "uranium", "ai").
// Each bucket needle list includes both so a filter tab matches
// regardless of which vintage populated the entity.
const INDUSTRY_GROUPS: Record<string, string[]> = {
  portfolio: [], // special: matches all core rows
  technology: ["technology", "semiconductors", "ai", "hardware", "software"],
  materials: [
    "materials",
    "mining",
    "copper",
    "gold",
    "silver",
    "aluminum",
    "iron-ore",
    "lithium",
    "commodities",
  ],
  energy: [
    "energy",
    "uranium",
    "oil",
    "gas",
    "oil-gas",
    "oil-gas-services",
    "renewables",
  ],
  healthcare: ["healthcare"],
  financials: [
    "financials",
    "financial-services",
    "exchanges",
    "alternative-asset-management",
  ],
  consumer: ["consumer-cyclical", "consumer-defensive"],
  industrials: ["industrials"],
  communications: ["communication-services"],
  realestate: ["real-estate"],
  utilities: ["utilities"],
  developer: ["developer"],
};

type Filter =
  | "portfolio"
  | "sp500"
  | "technology"
  | "materials"
  | "energy"
  | "healthcare"
  | "financials"
  | "consumer"
  | "industrials"
  | "communications"
  | "realestate"
  | "utilities"
  | "developer";
type SortKey = "next" | "surprise" | "reaction" | "freshness" | "name";
type Group = "flat" | "type" | "sector" | "industry" | "cap-industry";
const CAP_TIER_ORDER: Array<"mega" | "large" | "mid" | "small" | "unknown"> = [
  "mega",
  "large",
  "mid",
  "small",
  "unknown",
];
const CAP_TIER_LABEL: Record<string, string> = {
  mega: "Mega cap · ≥$200B",
  large: "Large cap · $10B–$200B",
  mid: "Mid cap · $2B–$10B",
  small: "Small cap · $250M–$2B",
  unknown: "Nano / unknown",
};
type TierFilter = "any" | "mega" | "large" | "mid" | "small" | "unknown";

export function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("portfolio");
  const [sortKey, setSortKey] = useState<SortKey>("next");
  const [reportingSoon, setReportingSoon] = useState(false);
  const [group, setGroup] = useState<Group>("flat");
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [tier, setTier] = useState<TierFilter>("any");
  // Canonical-listings-only by default — so NVIDIA counts once in
  // large-cap tech instead of four times (once per BDR / MM / TB / CN
  // wrapper listing). Portfolio rows (isCore) always show regardless,
  // so the 17 covered tickers are never hidden even if a rare one
  // happens not to be canonical of its company group.
  const [showAllListings, setShowAllListings] = useState(false);
  // Sibling-listing counts per company — used for the "+N listings"
  // badge on canonical rows and to expose the hidden members via title.
  const listingsByCompany = useMemo(() => {
    const m = new Map<string, WatchlistRow[]>();
    for (const r of rows) {
      const cid = r.entity.companyId ?? r.entity.ticker;
      if (!m.has(cid)) m.set(cid, []);
      m.get(cid)!.push(r);
    }
    return m;
  }, [rows]);

  // Real 1-month prices + Yahoo earnings, fetched in parallel on mount.
  const [prices, setPrices] = useState<BulkPricesResponse | null>(null);
  const [pricesLoading, setPricesLoading] = useState(true);
  const [earnings, setEarnings] = useState<BulkEarningsResponse | null>(null);

  useEffect(() => {
    const tickers = rows.map((r) => r.ticker).join(",");
    const encoded = encodeURIComponent(tickers);
    fetch(`/api/prices/bulk?tickers=${encoded}&range=1mo`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: BulkPricesResponse | null) => setPrices(j))
      .catch(() => setPrices(null))
      .finally(() => setPricesLoading(false));

    fetch(`/api/earnings/yahoo/bulk?tickers=${encoded}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: BulkEarningsResponse | null) => setEarnings(j))
      .catch(() => setEarnings(null));
    // Fetch once on mount — ticker list is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    let list = rows.slice();
    if (filter === "portfolio") {
      // Portfolio = core watchlist (17 tickers from prompt1.txt).
      // Sector-universe entities (isCore:false) live under the tab
      // labels below and on /admin.
      list = list.filter((r) => r.entity.isCore);
    } else if (filter === "sp500") {
      // Index membership filter — SP500 is NOT a sector, so we can't
      // use sectorTags here. Constituents keep their real GICS
      // sectors + industry groups; this filter just narrows the
      // universe to the 503 flagged in the daily reference file.
      list = list.filter((r) => (r.entity.index_membership ?? []).includes("SP500"));
    } else {
      const needles = INDUSTRY_GROUPS[filter] ?? [];
      list = list.filter((r) => {
        if (filter === "developer") return r.entity.securityType === "developer";
        return r.entity.sectorTags.some((t) => needles.includes(t));
      });
    }
    if (reportingSoon) {
      list = list.filter(
        (r) => r.nextEvent.daysUntil !== null && r.nextEvent.daysUntil <= 14,
      );
    }
    if (tier !== "any") {
      list = list.filter((r) => (r.entity.capTier ?? "unknown") === tier);
    }
    if (!showAllListings) {
      // Canonical-only default. isCore is a hard OVERRIDE — the 17
      // covered tickers always show even if the audit picked a
      // different member as canonical of their company (rare, but
      // preserves the "don't remap" invariant from the prompt).
      list = list.filter((r) => r.entity.isCanonical || r.entity.isCore);
    }
    list.sort((a, b) => {
      switch (sortKey) {
        case "next":
          return (
            (a.nextEvent.daysUntil ?? 999) - (b.nextEvent.daysUntil ?? 999)
          );
        case "surprise":
          return (b.lastSurprisePct ?? -Infinity) - (a.lastSurprisePct ?? -Infinity);
        case "reaction": {
          const av = a.reactionSpark[0] ?? 0;
          const bv = b.reactionSpark[0] ?? 0;
          return bv - av;
        }
        case "freshness": {
          const order = { fresh: 0, overdue: 1, stale: 2, never: 3 } as const;
          return order[a.freshness] - order[b.freshness];
        }
        case "name":
          return a.entity.displayName.localeCompare(b.entity.displayName);
      }
    });
    return list;
  }, [rows, filter, reportingSoon, sortKey, tier]);

  const grouped = useMemo(() => {
    if (group === "flat") return [{ id: "", label: "", rows: filtered }];

    // "cap-industry" mode: two-level grouping — cap tier at the top,
    // industry group underneath. We flatten to a single-level list so
    // the existing render loop keeps working, but the labels are
    // constructed as "<Cap band> · <Industry group>". Cap bands sort
    // in fixed order (mega→large→mid→small→unknown); industries within
    // a band sort by row count desc so the biggest sub-groups surface
    // first.
    if (group === "cap-industry") {
      const byBand = new Map<string, Map<string, WatchlistRow[]>>();
      for (const r of filtered) {
        const band = (r.entity.capTier ?? "unknown") as string;
        const ind = r.entity.industryGroup ?? "(unclassified)";
        if (!byBand.has(band)) byBand.set(band, new Map());
        const inner = byBand.get(band)!;
        if (!inner.has(ind)) inner.set(ind, []);
        inner.get(ind)!.push(r);
      }
      const out: Array<{ id: string; label: string; rows: WatchlistRow[] }> = [];
      for (const band of CAP_TIER_ORDER) {
        const inner = byBand.get(band);
        if (!inner) continue;
        const industries = [...inner.entries()].sort(
          (a, b) => b[1].length - a[1].length,
        );
        for (const [ind, rows] of industries) {
          out.push({
            id: `${band}::${ind}`,
            label: `${CAP_TIER_LABEL[band] ?? band}  ·  ${ind}`,
            rows,
          });
        }
      }
      return out;
    }

    const map = new Map<string, WatchlistRow[]>();
    for (const r of filtered) {
      const key =
        group === "type"
          ? r.entity.securityType
          : group === "industry"
          ? r.entity.industryGroup ?? "(unclassified)"
          : r.entity.sectorTags[0] ?? "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    // Sort industry / sector groups by row count desc so meaningful
    // buckets rise to the top; type stays alpha for a stable order.
    const entries = [...map.entries()];
    if (group !== "type") entries.sort((a, b) => b[1].length - a[1].length);
    return entries.map(([id, rows]) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      rows,
    }));
  }, [filtered, group]);

  return (
    <div>
      <FilterBar
        filter={filter}
        setFilter={setFilter}
        sortKey={sortKey}
        setSortKey={setSortKey}
        reportingSoon={reportingSoon}
        setReportingSoon={setReportingSoon}
        group={group}
        setGroup={setGroup}
      />

      <div className="mt-2 flex flex-wrap items-center gap-[6px]">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-tx3">
          Cap tier
        </span>
        {(
          [
            { id: "any", label: "Any" },
            { id: "mega", label: "Mega ≥$200B" },
            { id: "large", label: "Large $10B–$200B" },
            { id: "mid", label: "Mid $2B–$10B" },
            { id: "small", label: "Small $250M–$2B" },
            { id: "unknown", label: "Nano / n/a" },
          ] as Array<{ id: TierFilter; label: string }>
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTier(t.id)}
            className={
              tier === t.id
                ? "inline-flex h-[22px] items-center rounded-[5px] border border-brand bg-brand/10 px-[9px] text-[11px] text-brand-fg"
                : "inline-flex h-[22px] items-center rounded-[5px] border border-bd2 bg-s2 px-[9px] text-[11px] text-tx2 hover:text-tx"
            }
          >
            {t.label}
          </button>
        ))}
        <span className="ml-3 font-mono text-[10.5px] uppercase tracking-[0.1em] text-tx3">
          Listings
        </span>
        <button
          onClick={() => setShowAllListings((v) => !v)}
          title={
            showAllListings
              ? "Showing every listing including BDR / ADR / GY wrappers"
              : "Only the canonical listing per company (default). NVIDIA appears once, not four times."
          }
          className={
            showAllListings
              ? "inline-flex h-[22px] items-center rounded-[5px] border border-brand bg-brand/10 px-[9px] text-[11px] text-brand-fg"
              : "inline-flex h-[22px] items-center rounded-[5px] border border-bd2 bg-s2 px-[9px] text-[11px] text-tx2 hover:text-tx"
          }
        >
          {showAllListings ? "All listings" : "Canonical only"}
        </button>
      </div>

      <div
        // `overflow-hidden` on the container broke position:sticky for
        // the HeaderRow — sticky pins to the closest ancestor that
        // establishes a scroll container, and overflow:hidden qualifies.
        // Result: the header scrolled with the rows, and the first data
        // row could visually appear above the (no-longer-pinned) header.
        // We drop overflow-hidden; the rounded-panel border still gives
        // us clean visual edges since no child overflows its cells.
        // isolation:isolate keeps sub-tree stacking contained so no
        // absolute-positioned badge inside a row can render above the
        // sticky header (z-20 already puts the header above rows).
        className="mt-3 rounded-panel border border-bd bg-s1 [isolation:isolate]"
        role="grid"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            const r = filtered[selectedIdx];
            if (r) router.push(`/s/${encodeURIComponent(r.ticker)}`);
          }
        }}
      >
        <HeaderRow />
        {grouped.map((g) => (
          <div key={g.id}>
            {group !== "flat" && (
              <div className="border-b border-bd bg-panel2 px-[18px] py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-tx3">
                {g.label} · {g.rows.length}
              </div>
            )}
            {g.rows.map((r, i) => (
              <Row
                key={r.ticker}
                r={r}
                priceEntry={prices?.tickers[r.ticker]}
                earningsEntry={earnings?.tickers[r.ticker]}
                pricesLoading={pricesLoading}
                selected={filtered.indexOf(r) === selectedIdx}
                siblingCount={(() => {
                  const cid = r.entity.companyId ?? r.entity.ticker;
                  const list = listingsByCompany.get(cid);
                  return list ? list.length - 1 : 0;
                })()}
                siblingTickers={(() => {
                  const cid = r.entity.companyId ?? r.entity.ticker;
                  const list = listingsByCompany.get(cid) ?? [];
                  return list
                    .filter((s) => s.ticker !== r.ticker)
                    .map((s) => s.ticker);
                })()}
                onClick={() =>
                  router.push(`/s/${encodeURIComponent(r.ticker)}`)
                }
              />
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="p-8 text-center text-[13px] text-tx-mid">
            No rows match the current filters.
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-4 text-[11.5px] text-tx-mid">
        <StalenessLegend />
        <span className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.08em]">
          ↑↓ navigate · ⏎ open
        </span>
      </div>
    </div>
  );
}

function HeaderRow() {
  return (
    <div
      // z-20 keeps the header above any row content that establishes its
      // own stacking context (rounded pills, sparkline SVG etc.). Site
      // header uses z-30 so this still sits below it. Inline background
      // makes the opaque cover unconditional — no chance for a Tailwind
      // purge or var lookup to leave it transparent.
      className="sticky top-14 z-20 grid grid-cols-[2fr_1.3fr_1.1fr_1fr_1.2fr_0.7fr_0.7fr] gap-3 border-b border-bd px-[18px] py-[11px] font-mono text-[10px] uppercase tracking-[0.08em] text-tx3"
      style={{ background: "var(--panel2)" }}
    >
      <span className="text-tx2">Name ▾</span>
      <span>Next event</span>
      <span>Last surprise</span>
      <span>Guidance</span>
      <span>Price · 1M</span>
      <span className="text-center">Fresh</span>
      <span className="text-right">Src</span>
    </div>
  );
}

function Row({
  r,
  onClick,
  selected,
  priceEntry,
  earningsEntry,
  pricesLoading,
  siblingCount,
  siblingTickers,
}: {
  r: WatchlistRow;
  onClick: () => void;
  selected: boolean;
  priceEntry?: BulkPriceEntry;
  earningsEntry?: BulkEarningsEntry;
  pricesLoading?: boolean;
  siblingCount?: number;
  siblingTickers?: string[];
}) {
  const isDev = r.entity.securityType === "developer";
  const isEtf = r.entity.securityType === "etf";
  const yahoo = earningsEntry?.ok ? earningsEntry.data : null;
  // "Last surprise" reads as the market's reaction to the last report,
  // not the analyst beat/miss on EPS. The 3-day post-earnings absolute
  // return is the trader's surprise — SEC-vs-consensus EPS ratios are
  // often cross-basis (GAAP actual vs adjusted consensus) and mislead.
  // Fall back to the analyst compare only when we have no reaction bar
  // (foreign wrappers whose Yahoo v8 chart is empty).
  const d3 = (r.reactionPoints ?? []).find((p) => p.horizon === "d3");
  const reactionPct =
    d3 && d3.absReturn != null && (d3.status === "matured" || d3.status === "clipped")
      ? d3.absReturn * 100
      : null;
  const surprise =
    reactionPct ?? r.lastSurprisePct ?? yahoo?.lastQuarter?.surprisePct ?? null;
  const nextIso = r.nextEvent.date ?? yahoo?.nextEarningsDate ?? null;
  // Date-only diff (via daysUntil helper) — both sides anchor at UTC
  // midnight so a same-day scheduled event reads "today", not "1d ago".
  const daysUntil = nextIso ? daysUntilFn(nextIso) : null;
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={clsx(
        "border-b border-bd last:border-b-0 transition-colors",
        selected ? "bg-hover" : "hover:bg-hover",
        r.recentEvent && "bg-[rgba(47,127,255,0.05)]",
      )}
    >
    <div
      role="row"
      tabIndex={-1}
      onClick={onClick}
      className={clsx(
        "grid cursor-pointer grid-cols-[2fr_1.3fr_1.1fr_1fr_1.2fr_0.7fr_0.7fr] items-center gap-3 px-[18px] py-3",
      )}
    >
      <div className="flex min-w-0 items-center gap-[10px]">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-label={expanded ? "Collapse reaction" : "Expand reaction"}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-hover2 text-tx3 hover:text-tx"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <TickerLogo
          ticker={r.ticker}
          name={r.entity.displayName}
          size={28}
        />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13.5px] font-medium text-tx">
            {r.entity.displayName}
          </span>
          <span className="flex items-center gap-2 truncate font-mono text-[11px] text-tx-mid">
            {r.ticker}
            {siblingCount && siblingCount > 0 ? (
              <span
                className="rounded-[4px] bg-s3 px-[5px] py-[1px] text-[10px] text-tx2"
                title={
                  siblingTickers && siblingTickers.length > 0
                    ? "Also listed as: " + siblingTickers.join(", ")
                    : undefined
                }
              >
                +{siblingCount} listings
              </span>
            ) : null}
            {r.dataIncomplete ? (
              <span
                className="inline-flex items-center gap-[3px] rounded-[4px] bg-[rgba(181,71,8,0.10)] px-[5px] py-[1px] text-[10px] text-warning"
                title="Data incomplete — waiting on next refresh"
              >
                <AlertTriangle size={9} /> incomplete
              </span>
            ) : null}
          </span>
        </div>
      </div>

      <span
        className={clsx(
          "font-mono text-[12.5px]",
          daysUntil !== null && daysUntil <= 3
            ? "text-warning"
            : nextIso
            ? "text-tx-strong"
            : "text-tx3",
        )}
      >
        {nextIso ? (
          r.nextEvent.cadence === "semiannual" ||
          r.nextEvent.cadence === "annual" ? (
            // Fuzzy cadence label — the estimator only knows the month.
            <span title={nextIso}>{r.nextEvent.label}</span>
          ) : (
            <>
              {fmtDateShort(nextIso)}{" "}
              <span className="text-tx-mid">
                · {fmtDaysUntil(daysUntil)}
              </span>
            </>
          )
        ) : isEtf ? (
          "—"
        ) : (
          <span className="italic text-tx-mid">unscheduled</span>
        )}
      </span>

      <span>
        {isDev || isEtf ? (
          <span className="text-[12.5px] text-tx3">—</span>
        ) : (
          <SurprisePill
            surprisePct={surprise}
            // r.lastPeriod present means we DO have a last-print event
            // for this ticker — the actual is reported, we just may not
            // have an estimate to compare against.
            hasActual={r.lastPeriod != null}
            compact
          />
        )}
      </span>

      <span className="text-[12.5px]">
        {isDev || isEtf ? (
          <span className="text-tx3">—</span>
        ) : (
          <GuidanceMoveBadge move={r.guidanceMove} />
        )}
      </span>

      <span className="flex items-center gap-2">
        <RealPriceSparkline
          series={priceEntry?.series ?? []}
          loading={pricesLoading}
          err={priceEntry && !priceEntry.ok ? priceEntry.err ?? "err" : null}
        />
        <span className="flex flex-col leading-tight">
          {priceEntry?.ok && typeof priceEntry.latest === "number" ? (
            <span className="font-mono text-[12px] tabular-nums text-tx-strong">
              {priceEntry.latest >= 1000
                ? priceEntry.latest.toFixed(0)
                : priceEntry.latest.toFixed(2)}
            </span>
          ) : (
            <span className="text-[11px] text-tx3">—</span>
          )}
          <PriceDeltaLabel
            pctChange={priceEntry?.ok && typeof priceEntry.pctChange === "number"
              ? priceEntry.pctChange
              : null}
          />
        </span>
      </span>

      <span className="text-center">
        <FreshnessDot state={r.freshness} />
      </span>

      <span className="text-right font-mono text-[12.5px] text-tx-strong">
        {r.sourceCount || "—"}
        {r.newSinceLastView > 0 ? (
          <span className="ml-1 rounded-[4px] bg-brand/20 px-[5px] py-[1px] text-[10px] text-brand-fg">
            +{r.newSinceLastView}
          </span>
        ) : null}
      </span>
    </div>
    {expanded ? (
      <div className="px-[18px] pb-3 pl-[50px]">
        <ReactionRow points={r.reactionPoints ?? []} size="xs" />
      </div>
    ) : null}
    </div>
  );
}

function FilterBar({
  filter,
  setFilter,
  sortKey,
  setSortKey,
  reportingSoon,
  setReportingSoon,
  group,
  setGroup,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  sortKey: SortKey;
  setSortKey: (s: SortKey) => void;
  reportingSoon: boolean;
  setReportingSoon: (v: boolean) => void;
  group: Group;
  setGroup: (g: Group) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap rounded-button border border-bd bg-s1 p-[3px]">
        {(
          [
            { id: "portfolio", label: "Our portfolio" },
            { id: "sp500", label: "S&P 500" },
            { id: "technology", label: "Technology" },
            { id: "materials", label: "Materials" },
            { id: "energy", label: "Energy" },
            { id: "healthcare", label: "Healthcare" },
            { id: "financials", label: "Financials" },
            { id: "consumer", label: "Consumer" },
            { id: "industrials", label: "Industrials" },
            { id: "communications", label: "Communications" },
            { id: "realestate", label: "Real estate" },
            { id: "utilities", label: "Utilities" },
            { id: "developer", label: "Developer" },
          ] as { id: Filter; label: string }[]
        ).map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={clsx(
              "rounded-[6px] px-3 py-[5px] text-[12.5px]",
              filter === f.id
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => setReportingSoon(!reportingSoon)}
        className={clsx(
          "rounded-button border px-3 py-[6px] text-[12.5px]",
          reportingSoon
            ? "border-brand bg-brand/10 text-brand-fg"
            : "border-bd text-tx2 hover:text-tx",
        )}
      >
        Reporting soon ≤ 14d
      </button>
      <select
        value={sortKey}
        onChange={(e) => setSortKey(e.target.value as SortKey)}
        className="h-8 rounded-button border border-bd bg-s1 px-2 text-[12.5px] text-tx2"
      >
        <option value="next">Sort: Next event</option>
        <option value="surprise">Sort: Surprise</option>
        <option value="reaction">Sort: Reaction (+1d)</option>
        <option value="freshness">Sort: Freshness</option>
        <option value="name">Sort: Name</option>
      </select>
      <select
        value={group}
        onChange={(e) => setGroup(e.target.value as Group)}
        className="h-8 rounded-button border border-bd bg-s1 px-2 text-[12.5px] text-tx2"
      >
        <option value="flat">Group: none</option>
        <option value="type">Group: type</option>
        <option value="sector">Group: sector</option>
        <option value="industry">Group: industry</option>
        <option value="cap-industry">Group: cap band × industry</option>
      </select>
    </div>
  );
}
