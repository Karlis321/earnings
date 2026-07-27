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
} from "@/components/primitives";
import { TickerLogo } from "@/components/primitives/TickerLogo";
import {
  RealPriceSparkline,
  PriceDeltaLabel,
} from "./RealPriceSparkline";
import { fmtDaysUntil, fmtDateShort } from "@/lib/format";
import { AlertTriangle } from "lucide-react";
import clsx from "clsx";

// Server response shape from /api/prices/bulk
interface BulkPriceEntry {
  ok: boolean;
  series: { date: string; close: number }[];
  pctChange?: number;
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

// Industry buckets — sectorTag → industry group. Anything not mapped falls
// through to "other".
const INDUSTRY_GROUPS: Record<string, string[]> = {
  portfolio: [], // special: all rows
  technology: ["semiconductors", "ai", "hardware", "software"],
  materials: ["copper", "gold", "silver", "aluminum", "iron-ore", "lithium", "mining"],
  energy: ["uranium", "oil", "gas", "energy", "renewables"],
  etfs: ["etf"],
  developer: ["developer"],
};

type Filter =
  | "portfolio"
  | "technology"
  | "materials"
  | "energy"
  | "etfs"
  | "developer";
type SortKey = "next" | "surprise" | "reaction" | "freshness" | "name";
type Group = "flat" | "type" | "sector";
type TierFilter = "any" | "mega" | "large" | "mid" | "small" | "unknown";

export function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("portfolio");
  const [sortKey, setSortKey] = useState<SortKey>("next");
  const [reportingSoon, setReportingSoon] = useState(false);
  const [group, setGroup] = useState<Group>("flat");
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [tier, setTier] = useState<TierFilter>("any");

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
    } else {
      const needles = INDUSTRY_GROUPS[filter] ?? [];
      list = list.filter((r) => {
        if (filter === "developer") return r.entity.securityType === "developer";
        if (filter === "etfs") return r.entity.securityType === "etf";
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
    const map = new Map<string, WatchlistRow[]>();
    for (const r of filtered) {
      const key =
        group === "type"
          ? r.entity.securityType
          : r.entity.sectorTags[0] ?? "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map, ([id, rows]) => ({
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
      <span>1-month reaction</span>
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
}: {
  r: WatchlistRow;
  onClick: () => void;
  selected: boolean;
  priceEntry?: BulkPriceEntry;
  earningsEntry?: BulkEarningsEntry;
  pricesLoading?: boolean;
}) {
  const isDev = r.entity.securityType === "developer";
  const isEtf = r.entity.securityType === "etf";
  const yahoo = earningsEntry?.ok ? earningsEntry.data : null;
  // Fixture value wins; fall back to Yahoo when fixture is empty.
  const surprise = r.lastSurprisePct ?? yahoo?.lastQuarter?.surprisePct ?? null;
  const nextIso = r.nextEvent.date ?? yahoo?.nextEarningsDate ?? null;
  const daysUntil = nextIso
    ? Math.round(
        (new Date(nextIso).getTime() - Date.now()) / 86_400_000,
      )
    : null;
  return (
    <div
      role="row"
      tabIndex={-1}
      onClick={onClick}
      className={clsx(
        "grid cursor-pointer grid-cols-[2fr_1.3fr_1.1fr_1fr_1.2fr_0.7fr_0.7fr] items-center gap-3 border-b border-bd px-[18px] py-3 last:border-b-0 transition-colors",
        selected ? "bg-hover" : "hover:bg-hover",
        r.recentEvent && "bg-[rgba(47,127,255,0.05)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-[10px]">
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
          <>
            {fmtDateShort(nextIso)}{" "}
            <span className="text-tx-mid">
              · {fmtDaysUntil(daysUntil)}
            </span>
          </>
        ) : isEtf ? (
          "—"
        ) : (
          <span className="italic text-tx-mid">unscheduled</span>
        )}
      </span>

      <span>
        {isDev || isEtf ? (
          <span className="text-[12.5px] text-tx3">—</span>
        ) : surprise === null ? (
          <span className="text-[12px] text-tx3">n/a</span>
        ) : (
          <SurprisePill surprisePct={surprise} compact />
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
        <PriceDeltaLabel
          pctChange={priceEntry?.ok && typeof priceEntry.pctChange === "number"
            ? priceEntry.pctChange
            : null}
        />
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
            { id: "technology", label: "Technology" },
            { id: "materials", label: "Materials" },
            { id: "energy", label: "Energy" },
            { id: "etfs", label: "ETFs" },
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
      </select>
    </div>
  );
}
