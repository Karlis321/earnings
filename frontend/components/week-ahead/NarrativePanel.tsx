"use client";

// Feature 2F — weekly AI narrative panel on /week-ahead. Renders
// the sections + highlights from data/week-ahead-narrative.json
// as a top panel above the macro extremity strip. Absent → the
// page renders exactly like pre-2F (macro strip + day grid).

import Link from "next/link";
import { Info } from "lucide-react";
import type { WeekAheadNarrative } from "@/lib/types";
import { TickerLogo } from "@/components/primitives/TickerLogo";
import { fmtWeekdayMonthDay as fmtDate } from "@/lib/format";

export function NarrativePanel({
  narrative,
}: {
  narrative: WeekAheadNarrative;
}) {
  return (
    <section
      aria-label="Week ahead narrative"
      className="mb-4 rounded-[8px] border border-bd bg-panel"
    >
      {/* Header */}
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-bd px-4 py-2">
        <h2 className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          § Narrative · week of {fmtDate(narrative.weekOf)}
        </h2>
        <span className="font-mono text-[10.5px] text-tx3">
          {narrative.eventsCount} events
        </span>
        <span className="ml-auto font-mono text-[10px] text-tx3">
          generated {narrative.generatedAt.slice(0, 16).replace("T", " ")}Z
        </span>
      </header>

      {/* Sections — two-column layout on wide viewports, single column below md. */}
      <div className="grid grid-cols-1 gap-4 px-4 py-3 md:grid-cols-2 lg:grid-cols-3">
        {narrative.sections.map((s, i) => (
          <div key={i}>
            <h3 className="mb-1.5 text-[13.5px] font-semibold text-tx">
              {s.heading}
            </h3>
            <p className="text-[12.5px] leading-[1.55] text-tx-mid">
              {s.body}
            </p>
          </div>
        ))}
      </div>

      {/* Highlights strip */}
      {narrative.highlights.length > 0 ? (
        <div className="border-t border-bd px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.07em] text-tx3">
            Highlights · {narrative.highlights.length}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {narrative.highlights.map((h, i) => (
              <Link
                key={i}
                href={`/s/${encodeURIComponent(h.ticker)}`}
                className="flex items-start gap-2 rounded-[6px] border border-bd bg-s1 px-3 py-2 text-left hover:bg-hover"
              >
                <TickerLogo
                  ticker={h.ticker}
                  name={h.ticker}
                  size={22}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-brand-fg">
                      {h.ticker}
                    </span>
                    <span className="font-mono text-[10.5px] text-tx3">
                      {fmtDate(h.eventDate)}
                    </span>
                  </div>
                  <div className="mt-[2px] text-[11.5px] leading-[1.5] text-tx-mid">
                    {h.note}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {/* Disclaimer */}
      <div className="flex items-start gap-2 border-t border-bd px-4 py-2 text-[11px] leading-[1.5] text-tx3">
        <Info aria-hidden className="mt-[2px] h-[11px] w-[11px] shrink-0" />
        <span>{narrative.disclaimer}</span>
      </div>
    </section>
  );
}
