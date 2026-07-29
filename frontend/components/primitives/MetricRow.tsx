"use client";

import type { MetricEntry } from "@/lib/types";
import { SurprisePill } from "./SurprisePill";
import { FactPopover } from "./FactPopover";
import { FreshnessDot } from "./FreshnessDot";
import { computeFreshness } from "@/lib/freshness";
import { fmtMoney, fmtNumber } from "@/lib/format";

// The metric key carries the millions convention (`_m` suffix). The unit
// carries the currency. Combine both so KRW / CAD / JPY / etc. render
// with a scaled magnitude AND a visible currency prefix — surprise-%
// and beat/miss ratios are currency-safe within a ticker, but the raw
// figure needs the ISO code so cross-ticker readers don't silently mix.
function renderValue(fact: MetricEntry["actual"], key: string) {
  if (!fact || fact.value === null) return "—";
  const looksLikeCurrency = /^[A-Z]{3}(_m)?$/.test(fact.unit ?? "");
  if (looksLikeCurrency) {
    const storedInMillions = key.endsWith("_m") || fact.unit.endsWith("_m");
    return fmtMoney(fact.value, fact.unit, storedInMillions);
  }
  return fmtNumber(fact.value, 2);
}

export function MetricRow({
  metric,
  derived = false,
}: {
  metric: MetricEntry;
  derived?: boolean;
}) {
  const actualFresh = computeFreshness(metric.actual?.asOf ?? null);
  return (
    <div
      className={
        "grid grid-cols-[1.3fr_1fr_1fr_0.9fr_auto] items-center gap-3 border-b border-bd px-[18px] py-[13px] last:border-b-0" +
        (derived ? " opacity-70" : "")
      }
    >
      <div className="flex items-center gap-2 text-[13.5px] text-tx">
        {metric.displayLabel}
        {derived ? (
          <span className="rounded-[4px] bg-s3 px-[6px] py-[1px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-tx-mid">
            derived
          </span>
        ) : null}
      </div>

      <FactPopover
        fact={metric.actual}
        displayValue={renderValue(metric.actual, metric.key)}
      >
        <span
          className={
            "block text-right font-mono text-[14px] font-semibold text-tx tabular-nums"
          }
        >
          {renderValue(metric.actual, metric.key)}
        </span>
      </FactPopover>

      <FactPopover
        fact={metric.estimate}
        displayValue={renderValue(metric.estimate, metric.key)}
      >
        <span className="block text-right font-mono text-[14px] text-tx-mid tabular-nums">
          {renderValue(metric.estimate, metric.key)}
        </span>
      </FactPopover>

      <div className="flex justify-end">
        <SurprisePill
          surprisePct={metric.surprisePct}
          hasActual={metric.actual?.value != null}
          compact
        />
      </div>

      <FreshnessDot state={actualFresh} asOf={metric.actual?.asOf ?? null} />
    </div>
  );
}

export function MetricRowHeader() {
  return (
    <div className="grid grid-cols-[1.3fr_1fr_1fr_0.9fr_auto] items-center gap-3 border-b border-bd bg-panel2 px-[18px] py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
      <span>Metric</span>
      <span className="text-right">Actual</span>
      <span className="text-right">Estimate</span>
      <span className="text-right">Beat/miss</span>
      <span className="w-3" />
    </div>
  );
}
