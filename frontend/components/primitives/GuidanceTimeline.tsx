"use client";

import { useState } from "react";
import type { GuidanceEntry } from "@/lib/types";
import { GuidanceMoveBadge } from "./GuidanceMoveBadge";
import { FactPopover } from "./FactPopover";
import { fmtMoney, fmtNumber } from "@/lib/format";
import { ChevronDown } from "lucide-react";

function renderRange(
  low: GuidanceEntry["low"],
  high: GuidanceEntry["high"],
  key: string,
) {
  if (!low?.value || !high?.value) return "—";
  const unit = low.unit;
  const looksLikeCurrency = /^[A-Z]{3}(_m)?$/.test(unit ?? "");
  const storedInMillions = key.endsWith("_m") || unit.endsWith("_m");
  const fmt = (v: number) =>
    looksLikeCurrency ? fmtMoney(v, unit, storedInMillions) : fmtNumber(v, 2);
  return `${fmt(low.value)}–${fmt(high.value)}`;
}

export function GuidanceTimeline({ items }: { items: GuidanceEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!items.length) {
    return <div className="p-4 text-[13px] text-tx-mid">No guidance on file.</div>;
  }
  const current = items.filter((i) => i.supersededById === null);
  const superseded = items.filter((i) => i.supersededById !== null);
  return (
    <ol className="divide-y divide-bd">
      {current.map((g) => (
        <GuidanceRow key={`${g.key}-v${g.version}`} entry={g} />
      ))}
      {superseded.length > 0 && (
        <li className="px-[18px] py-3">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="flex items-center gap-[6px] text-[12.5px] text-tx-mid hover:text-tx"
          >
            <ChevronDown
              size={13}
              className={showAll ? "rotate-180 transition" : "transition"}
            />
            {showAll ? "Hide" : "Show"} {superseded.length} superseded version
            {superseded.length === 1 ? "" : "s"}
          </button>
          {showAll && (
            <ol className="mt-3 space-y-3 border-l-2 border-bd pl-4">
              {superseded.map((g) => (
                <GuidanceRow
                  key={`${g.key}-v${g.version}`}
                  entry={g}
                  superseded
                />
              ))}
            </ol>
          )}
        </li>
      )}
    </ol>
  );
}

function GuidanceRow({
  entry,
  superseded,
}: {
  entry: GuidanceEntry;
  superseded?: boolean;
}) {
  return (
    <li
      className={`px-[18px] py-4 ${superseded ? "opacity-60" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13.5px] text-tx">
          {entry.displayLabel}{" "}
          <span className="text-tx-mid">· {entry.period}</span>
        </div>
        <GuidanceMoveBadge move={entry.move} />
      </div>
      <div className="mt-2 flex items-baseline gap-4">
        <FactPopover fact={entry.midpoint ?? entry.low}>
          <span className="font-mono text-[16px] font-semibold tabular-nums">
            {renderRange(entry.low, entry.high, entry.key)}
          </span>
        </FactPopover>
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-tx3">
          basis · {entry.basis} · v{entry.version}
        </span>
      </div>
      {entry.low?.asOf ? (
        <div className="mt-1 font-mono text-[11px] text-tx3">
          as-of {entry.low.asOf}
        </div>
      ) : null}
    </li>
  );
}
