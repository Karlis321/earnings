"use client";

// Sector-detail row list with live price/change/sparkline.
// Fetches /api/prices/bulk once for all tickers passed in, then renders
// enriched rows. Loading state is a subtle skeleton per row so the list
// doesn't jump around.
//
// A local <select> sort control drives the render order. Sort applies
// inside each cap-band × industry group when the parent has grouped
// the rows (see WatchlistTable's `group === "cap-industry"` mode) —
// SectorMemberRows itself doesn't group, but the sort is deterministic
// enough to work inside a caller-provided pre-grouped subset.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { WatchlistRow } from "@/lib/types";
import {
  TypeBadge,
  FreshnessDot,
  SurprisePill,
  ReactionRow,
} from "@/components/primitives";
import {
  RealPriceSparkline,
  PriceDeltaLabel,
} from "@/components/overview/RealPriceSparkline";
import { fmtDateShort } from "@/lib/format";

interface BulkPriceEntry {
  ok: boolean;
  err?: string;
  series?: { date: string; close: number }[];
  latest?: number;
  pctChange?: number;
}
interface BulkPricesResponse {
  range: string;
  fetchedAt: string;
  tickers: Record<string, BulkPriceEntry>;
}

type SortKey = "cap-desc" | "cap-asc" | "name" | "next";

function compareRows(a: WatchlistRow, b: WatchlistRow, key: SortKey): number {
  switch (key) {
    case "cap-desc":
      return (b.entity.marketCapUsd ?? 0) - (a.entity.marketCapUsd ?? 0);
    case "cap-asc":
      return (a.entity.marketCapUsd ?? 0) - (b.entity.marketCapUsd ?? 0);
    case "name":
      return a.entity.displayName.localeCompare(b.entity.displayName);
    case "next":
      return (
        (a.nextEvent.daysUntil ?? 9_999) - (b.nextEvent.daysUntil ?? 9_999)
      );
  }
}

export function SectorMemberRows({ rows }: { rows: WatchlistRow[] }) {
  const [prices, setPrices] = useState<BulkPricesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("cap-desc");

  useEffect(() => {
    if (rows.length === 0) return;
    const tickers = rows.map((r) => r.ticker).join(",");
    fetch(`/api/prices/bulk?tickers=${encodeURIComponent(tickers)}&range=1mo`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: BulkPricesResponse | null) => setPrices(j))
      .catch(() => setPrices(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  const sorted = useMemo(
    () => rows.slice().sort((a, b) => compareRows(a, b, sortKey)),
    [rows, sortKey],
  );

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-bd bg-panel2 px-4 py-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          Sort
        </span>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="h-8 rounded-button border border-bd bg-s1 px-2 text-[12.5px] text-tx2"
        >
          <option value="cap-desc">Market cap ↓</option>
          <option value="cap-asc">Market cap ↑</option>
          <option value="name">Name A–Z</option>
          <option value="next">Next report date</option>
        </select>
      </div>
      {sorted.map((r) => (
        <SectorRow
          key={r.ticker}
          r={r}
          priceEntry={prices?.tickers[r.ticker]}
          loading={loading}
        />
      ))}
    </>
  );
}

function SectorRow({
  r,
  priceEntry,
  loading,
}: {
  r: WatchlistRow;
  priceEntry?: BulkPriceEntry;
  loading: boolean;
}) {
  const latest = priceEntry?.ok ? priceEntry.latest : undefined;
  const pctChange = priceEntry?.ok ? priceEntry.pctChange : undefined;
  const hasReaction = !!r.reactionPoints && r.reactionPoints.length > 0;
  return (
    <div className="border-b border-bd last:border-b-0 hover:bg-hover">
      <Link
        href={`/s/${encodeURIComponent(r.ticker)}`}
        className="grid grid-cols-[1.4fr_0.9fr_1.4fr_0.7fr_auto] items-center gap-3 px-4 py-3"
      >
        <span className="flex items-center gap-2 truncate">
          <TypeBadge type={r.entity.securityType} size="sm" />
          <span className="truncate text-[13.5px] text-tx">
            {r.entity.displayName}
          </span>
          <span className="truncate font-mono text-[11px] text-tx-mid">
            {r.ticker}
          </span>
          {r.entity.capTier && r.entity.capTier !== "unknown" ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-tx3">
              {r.entity.capTier}
            </span>
          ) : null}
        </span>
        <span className="font-mono text-[12.5px] text-tx-mid">
          {r.nextEvent.date
            ? r.nextEvent.cadence === "semiannual" ||
              r.nextEvent.cadence === "annual"
              ? r.nextEvent.label
              : fmtDateShort(r.nextEvent.date)
            : "—"}
        </span>
        <span className="flex items-center gap-2">
          <RealPriceSparkline
            series={priceEntry?.series ?? []}
            loading={loading}
            err={priceEntry && !priceEntry.ok ? priceEntry.err ?? "err" : null}
          />
          <span className="flex flex-col leading-tight">
            {typeof latest === "number" ? (
              <span className="font-mono text-[12px] tabular-nums text-tx-strong">
                {latest >= 1000 ? latest.toFixed(0) : latest.toFixed(2)}
              </span>
            ) : (
              <span className="text-[11px] text-tx3">—</span>
            )}
            <PriceDeltaLabel
              pctChange={typeof pctChange === "number" ? pctChange : null}
            />
          </span>
        </span>
        <span>
          {r.entity.securityType === "operating" ? (
            <SurprisePill
              surprisePct={r.lastSurprisePct}
              hasActual={r.lastPeriod != null}
              compact
            />
          ) : (
            <span className="text-[12.5px] text-tx3">—</span>
          )}
        </span>
        <FreshnessDot state={r.freshness} />
      </Link>
      {hasReaction ? (
        <div className="px-4 pb-2">
          <ReactionRow points={r.reactionPoints ?? []} size="xs" />
        </div>
      ) : null}
    </div>
  );
}
