import type { EtfDistribution, EtfHolding } from "@/lib/types";
import { fmtDate } from "@/lib/format";

export function DistributionRow({ dist }: { dist: EtfDistribution }) {
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-3 border-b border-bd px-4 py-3 last:border-b-0">
      <span className="font-mono text-[12.5px] text-tx tabular-nums">
        {fmtDate(dist.exDate)}
      </span>
      <span className="text-right font-mono text-[13.5px] font-semibold tabular-nums">
        {dist.amount.toFixed(2)} {dist.currency}
      </span>
      <span className="text-right font-mono text-[12.5px] text-tx-mid tabular-nums">
        {dist.yieldPct.toFixed(1)}%
      </span>
    </div>
  );
}

export function DistributionsTable({
  distributions,
}: {
  distributions: EtfDistribution[];
}) {
  if (!distributions.length) {
    return <div className="p-4 text-[13px] text-tx-mid">No distributions on file.</div>;
  }
  return (
    <div>
      <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
        <span>Ex-date</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Yield</span>
      </div>
      {distributions.map((d) => (
        <DistributionRow key={d.exDate} dist={d} />
      ))}
    </div>
  );
}

export function HoldingsTable({ holdings }: { holdings: EtfHolding[] }) {
  if (!holdings.length) {
    return <div className="p-4 text-[13px] text-tx-mid">No holdings on file.</div>;
  }
  return (
    <div>
      <div className="grid grid-cols-[1fr_2fr_1fr_1fr] items-center gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
        <span>Ticker</span>
        <span>Name</span>
        <span className="text-right">Weight</span>
        <span className="text-right">As-of</span>
      </div>
      {holdings.map((h) => (
        <div
          key={h.ticker}
          className="grid grid-cols-[1fr_2fr_1fr_1fr] items-center gap-3 border-b border-bd px-4 py-[10px] last:border-b-0"
        >
          <span className="font-mono text-[12.5px] text-brand-fg">
            {h.ticker}
          </span>
          <span className="text-[13px] text-tx">{h.name}</span>
          <span className="text-right font-mono text-[13px] font-semibold tabular-nums">
            {h.weight.toFixed(1)}%
          </span>
          <span className="text-right font-mono text-[11.5px] text-tx3">
            {h.asOf}
          </span>
        </div>
      ))}
    </div>
  );
}
