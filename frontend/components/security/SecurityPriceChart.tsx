"use client";

import { useEffect, useState } from "react";
import { PriceChart, type PricePoint } from "@/components/charts/PriceChart";
import { Loader2, AlertTriangle } from "lucide-react";
import clsx from "clsx";

interface Props {
  ticker: string;
  displayName: string;
  currency?: string;
}

const RANGES: Array<{ id: string; label: string }> = [
  { id: "1mo", label: "1M" },
  { id: "3mo", label: "3M" },
  { id: "6mo", label: "6M" },
  { id: "1y", label: "1Y" },
  { id: "5y", label: "5Y" },
  { id: "max", label: "Max" },
];

export function SecurityPriceChart({ ticker, displayName, currency }: Props) {
  const [range, setRange] = useState("1y");
  const [series, setSeries] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    setSeries(null);
    const url = `/api/prices?ticker=${encodeURIComponent(ticker)}&range=${range}`;
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `${r.status}`);
        }
        return r.json() as Promise<{ series: PricePoint[] }>;
      })
      .then((j) => setSeries(j.series))
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [ticker, range]);

  return (
    <div className="rounded-panel border border-bd bg-s1 p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="mono-eyebrow">Price · Yahoo</div>
        <div className="flex gap-1 rounded-button border border-bd bg-s2 p-[3px]">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={clsx(
                "rounded-[6px] px-3 py-[5px] text-[12px] transition-colors",
                range === r.id
                  ? "bg-brand font-medium text-white"
                  : "text-tx2 hover:text-tx",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-tx-mid">
          <Loader2 size={14} className="animate-spin" />
          Fetching {displayName} · {range} price series…
        </div>
      ) : err ? (
        <div className="flex h-[220px] items-center justify-center gap-2 rounded-panel border border-[rgba(180,35,24,0.28)] bg-[rgba(180,35,24,0.05)] p-4 text-[13px] text-danger">
          <AlertTriangle size={14} />
          <span>
            Could not load Yahoo price series for <strong>{ticker}</strong>: {err}
          </span>
        </div>
      ) : series && series.length > 1 ? (
        <PriceChart
          series={series}
          label={displayName}
          currency={currency}
          height={240}
        />
      ) : (
        <div className="flex h-[220px] items-center justify-center text-[13px] text-tx-mid">
          No price data returned for {ticker}.
        </div>
      )}
    </div>
  );
}
