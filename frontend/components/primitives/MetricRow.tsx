"use client";

import type { MetricEntry } from "@/lib/types";
import { SurprisePill } from "./SurprisePill";
import { FactPopover } from "./FactPopover";
import { FreshnessDot } from "./FreshnessDot";
import { computeFreshness } from "@/lib/freshness";
import { fmtMoney, fmtNumber } from "@/lib/format";

function renderValue(fact: MetricEntry["actual"]) {
  if (!fact || fact.value === null) return "—";
  if (fact.unit.endsWith("_m") || fact.unit === "USD" || fact.unit === "EUR") {
    return fmtMoney(fact.value, fact.unit);
  }
  return fmtNumber(fact.value, 2);
}

export function MetricRow({ metric }: { metric: MetricEntry }) {
  const actualFresh = computeFreshness(metric.actual?.asOf ?? null);
  return (
    <div className="grid grid-cols-[1.3fr_1fr_1fr_0.9fr_auto] items-center gap-3 border-b border-bd px-[18px] py-[13px] last:border-b-0">
      <div className="flex items-center gap-2 text-[13.5px] text-tx">
        {metric.displayLabel}
      </div>

      <FactPopover fact={metric.actual} displayValue={renderValue(metric.actual)}>
        <span
          className={
            "block text-right font-mono text-[14px] font-semibold text-tx tabular-nums"
          }
        >
          {renderValue(metric.actual)}
        </span>
      </FactPopover>

      <FactPopover fact={metric.estimate} displayValue={renderValue(metric.estimate)}>
        <span className="block text-right font-mono text-[14px] text-tx-mid tabular-nums">
          {renderValue(metric.estimate)}
        </span>
      </FactPopover>

      <div className="flex justify-end">
        <SurprisePill surprisePct={metric.surprisePct} compact />
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
