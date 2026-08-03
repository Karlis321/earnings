"use client";

// Client-side filter + view-mode toggle for a sector / index-membership
// grouping view. Wraps the pre-grouped rows produced by the server
// component and provides:
//   • A live search input that jump-filters across every group.
//   • A view toggle: "Industry groups" (default, sub-grouped by
//     industryGroup) vs "Market cap" (single flat list, largest first).
//
// Match rule: substring on ticker (any listing), displayName, aliases,
// industryGroup. Case-insensitive. Empty query renders everything
// unchanged so first paint matches the original page shape.

import { useMemo, useState } from "react";
import type { WatchlistRow } from "@/lib/types";
import { Panel } from "@/components/primitives";
import { SectorMemberRows } from "./SectorMemberRows";
import { Search, X } from "lucide-react";

interface Group {
  id: string;
  rows: WatchlistRow[];
}

type ViewMode = "industry" | "cap";

export function SectorGroupsFilter({
  groups,
  totalRows,
}: {
  groups: Group[];
  totalRows: number;
}) {
  const [q, setQ] = useState("");
  const [view, setView] = useState<ViewMode>("industry");

  const { filteredGroups, matchCount } = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return { filteredGroups: groups, matchCount: totalRows };

    let match = 0;
    const out: Group[] = [];
    for (const g of groups) {
      const groupMatches = g.id.toLowerCase().includes(term);
      const rows = g.rows.filter((r) => {
        if (groupMatches) return true;
        const e = r.entity;
        if (r.ticker.toLowerCase().includes(term)) return true;
        if (e.displayName.toLowerCase().includes(term)) return true;
        if (e.aliases?.some((a) => a.toLowerCase().includes(term))) return true;
        if (e.industryGroup?.toLowerCase().includes(term)) return true;
        return false;
      });
      if (rows.length > 0) {
        out.push({ id: g.id, rows });
        match += rows.length;
      }
    }
    return { filteredGroups: out, matchCount: match };
  }, [q, groups, totalRows]);

  // Cap-mode: flatten filtered groups into one sorted list.
  const capList = useMemo(() => {
    if (view !== "cap") return [];
    const all: WatchlistRow[] = [];
    for (const g of filteredGroups) all.push(...g.rows);
    return all.sort(
      (a, b) => (b.entity.marketCapUsd ?? 0) - (a.entity.marketCapUsd ?? 0),
    );
  }, [view, filteredGroups]);

  return (
    <>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-[520px] min-w-[240px]">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tx3"
          />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter members — ticker, name, or industry…"
            className="h-9 w-full rounded-button border border-bd bg-s1 pl-8 pr-8 text-[13px] text-tx placeholder:text-tx3 focus:border-brand/40 focus:outline-none"
          />
          {q ? (
            <button
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[4px] p-1 text-tx3 hover:bg-hover hover:text-tx"
              aria-label="Clear filter"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>

        {/* View toggle: industry-grouped vs flat market-cap list. */}
        <div className="inline-flex rounded-button border border-bd bg-s1 p-[2px]">
          <button
            onClick={() => setView("industry")}
            className={`h-8 rounded-[4px] px-3 text-[12.5px] transition-colors ${
              view === "industry"
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx"
            }`}
          >
            Industry groups
          </button>
          <button
            onClick={() => setView("cap")}
            className={`h-8 rounded-[4px] px-3 text-[12.5px] transition-colors ${
              view === "cap"
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx"
            }`}
          >
            Market cap ↓
          </button>
        </div>

        {q ? (
          <span className="font-mono text-[11.5px] text-tx-mid">
            {matchCount} match{matchCount === 1 ? "" : "es"}
            {view === "industry"
              ? ` across ${filteredGroups.length} group${
                  filteredGroups.length === 1 ? "" : "s"
                }`
              : ""}
          </span>
        ) : null}
      </div>

      {filteredGroups.length === 0 ? (
        <div className="rounded-panel border border-bd bg-s1 px-5 py-10 text-center">
          <div className="text-[13.5px] text-tx-mid">
            No members match &ldquo;{q}&rdquo;.
          </div>
          <div className="mt-2 font-mono text-[11px] text-tx3">
            try a ticker like NVDA, a name like Nvidia, or an industry
          </div>
        </div>
      ) : view === "industry" ? (
        <div className="flex flex-col gap-4">
          {filteredGroups.map((g) => (
            <Panel
              key={g.id}
              eyebrow={`${g.id} · ${g.rows.length} · sorted by market cap`}
              padded={false}
            >
              <SectorMemberRows rows={g.rows} />
            </Panel>
          ))}
        </div>
      ) : (
        <Panel
          eyebrow={`All members · ${capList.length} · largest cap first`}
          padded={false}
        >
          <SectorMemberRows rows={capList} />
        </Panel>
      )}
    </>
  );
}
