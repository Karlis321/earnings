"use client";

import * as Popover from "@radix-ui/react-popover";
import type { Fact } from "@/lib/types";
import { computeFreshness, freshnessLabel } from "@/lib/freshness";
import { FreshnessDot } from "./FreshnessDot";
import { fmtDate } from "@/lib/format";
import { ExternalLink } from "lucide-react";
import { useSourceViewer } from "@/providers/SourceViewerProvider";

// State: populated | manual | stale | absent — per FE PRD §6.
// Anchored to any sourced number; opens on click/hover.
export function FactPopover({
  fact,
  displayValue,
  children,
}: {
  fact: Fact | null;
  displayValue?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { openSource } = useSourceViewer();
  const isAbsent = !fact || fact.value === null;
  const isManual =
    fact?.method === "bloomberg_manual" || fact?.method === "filing_manual";
  const freshness = computeFreshness(fact?.asOf ?? null);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="cursor-help border-none bg-transparent p-0 text-inherit font-inherit">
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[290px] rounded-panel border border-bd2 bg-s2 p-4 shadow-[var(--sh-popover)]"
        >
          <div className="mono-eyebrow mb-3">Fact popover</div>

          {isAbsent ? (
            <div className="text-[13px] text-tx2">
              No source on file. Value shown as <span className="font-mono">—</span>.
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-baseline gap-2">
                <span className="font-mono text-[22px] font-semibold">
                  {displayValue ?? fact!.value}
                </span>
                <span className="text-[12px] text-tx-mid">
                  {fact!.unit.replace("_m", "")}
                  {fact!.confidence < 1 ? " · estimate" : ""}
                </span>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[6px] text-[11.5px]">
                <span className="text-tx3">source</span>
                <span className="text-tx">
                  {fact!.source?.label ?? "—"}
                  {isManual ? (
                    <span className="ml-2 rounded-[4px] bg-s3 px-[6px] py-[1px] text-[10px] text-warning">
                      manual
                    </span>
                  ) : null}
                </span>
                <span className="text-tx3">as-of</span>
                <span className="font-mono text-tx">{fact!.asOf}</span>
                <span className="text-tx3">fetched</span>
                <span className="font-mono text-tx">
                  {fact!.fetchedAt?.slice(0, 16).replace("T", " ") ?? "—"}
                </span>
                <span className="text-tx3">method</span>
                <span className="font-mono text-tx">{fact!.method}</span>
                <span className="text-tx3">fresh</span>
                <span className="flex items-center gap-[6px]">
                  <FreshnessDot state={freshness} size={7} />
                  <span className="text-tx">{freshnessLabel(freshness)}</span>
                </span>
              </div>

              {fact!.source ? (
                <button
                  onClick={() => openSource({ kind: "fact", source: fact!.source! })}
                  className="mt-3 flex h-8 w-full items-center justify-center gap-[6px] rounded-button border border-bd2 bg-s3 text-[12.5px] text-tx hover:border-[rgba(255,255,255,0.22)]"
                >
                  <ExternalLink size={12} />
                  View source
                </button>
              ) : null}
            </>
          )}
          <Popover.Arrow className="fill-s2" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
