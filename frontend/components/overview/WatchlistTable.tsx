"use client";

// The analyst home screen — dense sortable type-aware table.
// Filter/sort bar per FE PRD §7.2 (P4-T2).
// Row states: recent-event highlight, data-incomplete, unscheduled (P4-T3).

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { WatchlistRow, SecurityType } from "@/lib/types";
import {
  TypeBadge,
  SurprisePill,
  GuidanceMoveBadge,
  ReactionChart,
  FreshnessDot,
  StalenessLegend,
} from "@/components/primitives";
import { fmtDaysUntil, fmtDateShort } from "@/lib/format";
import { AlertTriangle } from "lucide-react";
import clsx from "clsx";

type Filter = "all" | SecurityType;
type SortKey = "next" | "surprise" | "reaction" | "freshness" | "name";
type Group = "flat" | "type" | "sector";

export function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("next");
  const [reportingSoon, setReportingSoon] = useState(false);
  const [group, setGroup] = useState<Group>("flat");
  const [selectedIdx, setSelectedIdx] = useState<number>(0);

  const filtered = useMemo(() => {
    let list = rows.slice();
    if (filter !== "all") list = list.filter((r) => r.entity.securityType === filter);
    if (reportingSoon) {
      list = list.filter(
        (r) => r.nextEvent.daysUntil !== null && r.nextEvent.daysUntil <= 14,
      );
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
  }, [rows, filter, reportingSoon, sortKey]);

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

      <div
        className="mt-3 overflow-hidden rounded-panel border border-bd bg-s1"
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
    <div className="sticky top-14 z-10 grid grid-cols-[2fr_1.3fr_1.1fr_1fr_1.2fr_0.7fr_0.7fr] gap-3 border-b border-bd bg-panel2 px-[18px] py-[11px] font-mono text-[10px] uppercase tracking-[0.08em] text-tx3">
      <span className="text-tx2">Name ▾</span>
      <span>Next event</span>
      <span>Last surprise</span>
      <span>Guidance</span>
      <span>Reaction d1·d3·w1·m1</span>
      <span className="text-center">Fresh</span>
      <span className="text-right">Src</span>
    </div>
  );
}

function Row({
  r,
  onClick,
  selected,
}: {
  r: WatchlistRow;
  onClick: () => void;
  selected: boolean;
}) {
  const isDev = r.entity.securityType === "developer";
  const isEtf = r.entity.securityType === "etf";
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
      <div className="flex items-center gap-[10px]">
        <TypeBadge type={r.entity.securityType} size="sm" />
        <div className="flex items-baseline gap-2">
          <span className="text-[13.5px] font-medium text-tx">
            {r.entity.displayName}
          </span>
          <span className="font-mono text-[11.5px] text-tx-mid">
            {r.ticker}
          </span>
          {r.dataIncomplete && (
            <span
              className="ml-1 inline-flex items-center gap-[3px] rounded-[4px] bg-[rgba(251,191,36,0.12)] px-[5px] py-[1px] text-[10px] text-warning"
              title="Data incomplete — waiting on next refresh"
            >
              <AlertTriangle size={9} /> incomplete
            </span>
          )}
        </div>
      </div>

      <span
        className={clsx(
          "font-mono text-[12.5px]",
          r.nextEvent.daysUntil !== null && r.nextEvent.daysUntil <= 3
            ? "text-warning"
            : r.nextEvent.date
            ? "text-tx-strong"
            : "text-tx3",
        )}
      >
        {r.nextEvent.date ? (
          <>
            {fmtDateShort(r.nextEvent.date)}{" "}
            <span className="text-tx-mid">
              · {fmtDaysUntil(r.nextEvent.daysUntil)}
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
        ) : r.lastSurprisePct === null ? (
          <span className="text-[12px] text-tx3">n/a</span>
        ) : (
          <SurprisePill surprisePct={r.lastSurprisePct} compact />
        )}
      </span>

      <span className="text-[12.5px]">
        {isDev || isEtf ? (
          <span className="text-tx3">—</span>
        ) : (
          <GuidanceMoveBadge move={r.guidanceMove} />
        )}
      </span>

      <span>
        {isEtf ? (
          <span className="text-[12.5px] text-tx3">—</span>
        ) : r.reactionSpark.length ? (
          <ReactionChart
            variant="spark"
            points={r.reactionSpark.map((v, i) => ({
              horizon: (["d1", "d3", "w1", "m1"][i] as any),
              absReturn: r.reactionPending && i > 0 ? null : v,
              excessReturn: null,
              benchmark: r.entity.benchmark,
              computedAt: null,
            }))}
          />
        ) : (
          <span className="text-[12.5px] text-tx3">—</span>
        )}
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
      <div className="flex rounded-button border border-bd bg-s1 p-[3px]">
        {(["all", "operating", "developer", "etf"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              "rounded-[6px] px-3 py-[5px] text-[12.5px] capitalize",
              filter === f
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx",
            )}
          >
            {f}
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
