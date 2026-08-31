// Phase 4.2 — commodity strip rendered above the day grid on
// /week-ahead. Compact 8-item row: label · price · 1d% · 30d%
// grouped by energy / precious / base / ag. Server component; no
// client-side fetching. Data comes from data/commodities.json via
// scripts/refresh-commodities.mjs.

import clsx from "clsx";
import type { Commodities, CommodityItem } from "@/lib/types";
import { fmtSurprisePct as fmtPct } from "@/lib/format";

interface Props {
  data: Commodities;
}

function pctClass(v: number | null): string {
  if (v === null) return "text-tx3";
  if (v > 0.2) return "text-success-fg";
  if (v < -0.2) return "text-danger";
  return "text-tx-mid";
}

function fmtPrice(v: number, unit: string): string {
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

function CommodityCard({ item }: { item: CommodityItem }) {
  const price = item.latest?.close ?? null;
  return (
    <div
      className="rounded-[6px] border border-bd bg-panel2/60 px-2 py-1.5"
      title={`${item.label} · ${item.symbol} · ${item.unit}${item.error ? ` · ${item.error}` : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11.5px] text-tx">{item.label}</span>
        <span className="font-mono text-[11.5px] tabular-nums text-tx-hi">
          {price === null ? "—" : fmtPrice(price, item.unit)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between font-mono text-[9.5px] tabular-nums">
        <span className={clsx(pctClass(item.change1d))}>
          1d {fmtPct(item.change1d)}
        </span>
        <span className={clsx(pctClass(item.change30d))}>
          30d {fmtPct(item.change30d)}
        </span>
      </div>
    </div>
  );
}

export function CommodityStrip({ data }: Props) {
  if (!data.items.length) return null;
  const grouped: Record<CommodityItem["group"], CommodityItem[]> = {
    energy: [],
    precious: [],
    base: [],
    ag: [],
  };
  for (const item of data.items) grouped[item.group].push(item);

  const asOf = data.generatedAt.slice(0, 10);

  return (
    <section className="mb-4" aria-label="Commodity prices">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="mono-eyebrow text-tx3">§ Commodities</span>
        <span className="font-mono text-[10.5px] text-tx3">
          spot vs 6mo · as of {asOf}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {data.items.map((item) => (
          <CommodityCard key={item.symbol} item={item} />
        ))}
      </div>
    </section>
  );
}
