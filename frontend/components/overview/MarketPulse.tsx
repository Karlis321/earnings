"use client";

// Overview mini-chart · 1-month index price series.
// Uses the shared PriceChart component.

import { useEffect, useState } from "react";
import { PriceChart, type PricePoint } from "@/components/charts/PriceChart";
import { Loader2, AlertTriangle } from "lucide-react";
import clsx from "clsx";

interface PricesResponse {
  symbol: string;
  range: string;
  series: PricePoint[];
}

const INDICES: Array<{ symbol: string; label: string }> = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^NDX", label: "Nasdaq 100" },
  { symbol: "^STOXX50E", label: "Euro Stoxx 50" },
  { symbol: "^VIX", label: "VIX" },
];

export function MarketPulse() {
  const [active, setActive] = useState(INDICES[0]);
  const [data, setData] = useState<PricesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    setData(null);
    const url = `/api/prices?symbol=${encodeURIComponent(active.symbol)}&range=1mo`;
    fetch(url, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((j: PricesResponse) => setData(j))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [active.symbol]);

  return (
    <div className="mb-6 rounded-panel border border-bd bg-s1 p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="mono-eyebrow mb-1">Market pulse · 1 month</div>
          <div className="text-[13px] text-tx-mid">
            {(() => {
              const lastBar = data && data.series.length > 0 ? data.series[data.series.length - 1].date : null;
              const now = new Date();
              const utcHour = now.getUTCHours();
              const marketOpen = utcHour >= 13 && utcHour < 20;
              const beforeOpen = utcHour < 13;
              const afterClose = utcHour >= 20;
              let statusNote = "";
              if (lastBar) {
                if (marketOpen) statusNote = " · US market open — today's bar finalizes after 20:00 UTC close";
                else if (beforeOpen) statusNote = " · US market pre-open — today's bar starts trading 13:30 UTC";
                else if (afterClose) statusNote = " · US market closed — today's bar finalized";
              }
              return (
                <>
                  Daily closes via Yahoo · last bar = {lastBar ?? "loading…"}
                  {statusNote}
                </>
              );
            })()}
          </div>
        </div>
        <div className="flex gap-1 rounded-button border border-bd bg-s2 p-[3px]">
          {INDICES.map((idx) => (
            <button
              key={idx.symbol}
              onClick={() => setActive(idx)}
              className={clsx(
                "rounded-[6px] px-3 py-[5px] text-[12px]",
                active.symbol === idx.symbol
                  ? "bg-brand font-medium text-white"
                  : "text-tx2 hover:text-tx",
              )}
            >
              {idx.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-tx-mid">
          <Loader2 size={14} className="animate-spin" />
          Fetching {active.label} · 1-month series…
        </div>
      ) : err ? (
        <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-danger">
          <AlertTriangle size={14} />
          Failed to load {active.label}: {err}
        </div>
      ) : data && data.series.length > 1 ? (
        <PriceChart series={data.series} label={active.label} height={200} />
      ) : (
        <div className="flex h-[220px] items-center justify-center text-[13px] text-tx-mid">
          No data returned.
        </div>
      )}
    </div>
  );
}
