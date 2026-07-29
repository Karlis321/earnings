"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Summary } from "@/lib/types";
import { SummaryCard } from "./SummaryPanel";

// Compact expandable list of prior-period summaries. Rendered under
// the main SummaryPanel when 2+ summaries exist. Collapsed by default —
// analysts working the latest print shouldn't have to scroll past
// history to read the current period.
export function OlderSummaries({ summaries }: { summaries: Summary[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (key: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="mt-4 rounded-[10px] border border-bd bg-panel2/40">
      <p className="border-b border-bd px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
        Earlier summaries ({summaries.length})
      </p>
      <ul className="divide-y divide-bd">
        {summaries.map((s) => {
          const key = `${s.ticker}_${s.period}`;
          const open = openIds.has(key);
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => toggle(key)}
                aria-expanded={open}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-s2/60"
              >
                {open ? (
                  <ChevronDown aria-hidden className="h-4 w-4 text-tx3" />
                ) : (
                  <ChevronRight aria-hidden className="h-4 w-4 text-tx3" />
                )}
                <span className="font-mono text-[11.5px] text-tx3">
                  {s.period}
                </span>
                <span className="text-[13.5px] font-medium text-tx">
                  {s.headline}
                </span>
                <span className="ml-auto font-mono text-[11px] text-tx3">
                  {s.reported_at}
                </span>
              </button>
              {open ? (
                <div className="border-t border-bd bg-panel px-4 py-3">
                  <SummaryCard summary={s} compact />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
