"use client";

// Sector-detail row list with live price/change/sparkline.
// Fetches /api/prices/bulk once for all tickers passed in, then renders
// enriched rows. Loading state is a subtle skeleton per row so the list
// doesn't jump around.

import Link from "next/link";
import { useEffect, useState } from "react";
import type { WatchlistRow } from "@/lib/types";
import {
  TypeBadge,
  FreshnessDot,
  SurprisePill,
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

export function SectorMemberRows({ rows }: { rows: WatchlistRow[] }) {
  const [prices, setPrices] = useState<BulkPricesResponse | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <>
      {rows.map((r) => (
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
  return (
    <Link
      href={`/s/${encodeURIComponent(r.ticker)}`}
      className="grid grid-cols-[1.4fr_0.9fr_1.4fr_0.7fr_auto] items-center gap-3 border-b border-bd px-4 py-3 last:border-b-0 hover:bg-hover"
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
  );
}
