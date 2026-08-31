// Compact TTM fundamentals strip. Rendered above the reaction panel
// on operating ticker pages. Data comes from entity.fundamentals,
// backfilled by scripts/backfills/backfill-fundamentals.mjs.
//
// Deliberately terse: 6 numbers, no chart. Analysts scan margin
// levels + revenue growth + forward EPS before they even open the
// income statement.

import type { Entity } from "@/lib/types";
import { fmtPct, fmtNumber } from "@/lib/format";

// Yahoo reports enterpriseValue in the filer's local currency
// (financialCurrency), not USD — Samsung Electronics 005930 KS
// comes back as 1.53e15 KRW ≈ $1.09T USD, not $1.5 quadrillion.
// Suffix scales to the local unit; the currency label lives in the
// section header (§ TTM fundamentals · KRW) so the reader can
// interpret the raw number.
function fmtEnterpriseValue(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return v.toLocaleString();
}

export function FundamentalsStrip({ entity }: { entity: Entity }) {
  const f = entity.fundamentals;
  if (!f) return null;

  // At least one figure must be present to bother rendering.
  const hasAny =
    f.grossMargin != null ||
    f.operatingMargin != null ||
    f.ebitdaMargin != null ||
    f.revenueGrowth != null ||
    f.forwardEps != null ||
    f.enterpriseValue != null;
  if (!hasAny) return null;

  return (
    <section
      aria-label="TTM fundamentals"
      className="rounded-panel border border-bd bg-panel px-4 py-3"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          § TTM fundamentals
          {f.currency ? (
            <span className="ml-2 text-tx-mid">· {f.currency}</span>
          ) : null}
        </h2>
        {f.asOf ? (
          <span className="font-mono text-[10px] text-tx3">as of {f.asOf}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
        <Cell label="Gross margin" value={fmtPct(f.grossMargin, 1)} />
        <Cell label="Operating" value={fmtPct(f.operatingMargin, 1)} />
        <Cell label="EBITDA" value={fmtPct(f.ebitdaMargin, 1)} />
        <Cell label="Revenue YoY" value={fmtPct(f.revenueGrowth, 1)} />
        <Cell label="Forward EPS" value={f.forwardEps != null ? fmtNumber(f.forwardEps, 2) : "—"} />
        <Cell label="Enterprise value" value={fmtEnterpriseValue(f.enterpriseValue)} />
      </div>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-tx3">
        {label}
      </div>
      <div className="mt-[2px] font-mono text-[14px] tabular-nums text-tx">
        {value}
      </div>
    </div>
  );
}
