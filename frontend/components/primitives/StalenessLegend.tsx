"use client";

import * as Popover from "@radix-ui/react-popover";
import { HelpCircle } from "lucide-react";

const ITEMS: Array<{ color: string; label: string; hint: string }> = [
  {
    color: "#34d399",
    label: "Fresh",
    hint: "Within the expected refresh window",
  },
  {
    color: "#fbbf24",
    label: "Overdue",
    hint: "Past the expected refresh window",
  },
  {
    color: "#f87171",
    label: "Stale / failed",
    hint: "Fetch failing or data critically old",
  },
  {
    color: "#4b5563",
    label: "Never fetched",
    hint: "No source ever obtained · shown as “—”",
  },
];

export function StalenessLegend({
  compact = false,
}: {
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className="flex items-center gap-[6px] rounded-button border border-bd bg-panel px-3 py-1 text-[12px] text-tx2 hover:text-tx"
            aria-label="Freshness legend"
          >
            <HelpCircle size={13} />
            Freshness
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            sideOffset={6}
            className="z-50 w-[280px] rounded-panel border border-bd2 bg-s3 p-4 shadow-[var(--sh-popover)]"
          >
            <div className="mono-eyebrow mb-2">Freshness legend</div>
            <ul className="space-y-2 text-[12px]">
              {ITEMS.map((i) => (
                <li key={i.label} className="flex items-start gap-[10px]">
                  <span
                    className="mt-[5px] inline-block h-[8px] w-[8px] flex-none rounded-full"
                    style={{ background: i.color }}
                  />
                  <div>
                    <div className="text-tx">{i.label}</div>
                    <div className="text-[11px] text-tx-mid">{i.hint}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-tx-mid">
      {ITEMS.map((i) => (
        <span key={i.label} className="flex items-center gap-[6px]">
          <span
            className="inline-block h-[8px] w-[8px] rounded-full"
            style={{ background: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}
