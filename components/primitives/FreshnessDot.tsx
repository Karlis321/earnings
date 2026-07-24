"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import type { Freshness } from "@/lib/types";
import { freshnessLabel } from "@/lib/freshness";

const colorMap: Record<Freshness, string> = {
  fresh: "#34d399",
  overdue: "#fbbf24",
  stale: "#f87171",
  never: "#4b5563",
};
const ringMap: Record<Freshness, string> = {
  fresh: "rgba(52,211,153,0.15)",
  overdue: "rgba(251,191,36,0.15)",
  stale: "rgba(248,113,113,0.15)",
  never: "transparent",
};

export function FreshnessDot({
  state,
  asOf,
  fetchedAt,
  size = 8,
}: {
  state: Freshness;
  asOf?: string | null;
  fetchedAt?: string | null;
  size?: number;
}) {
  const label = freshnessLabel(state);
  const tip = (
    <span className="text-[11.5px]">
      <strong className="text-tx">{label}</strong>
      {asOf ? <div className="text-tx2">as-of {asOf}</div> : null}
      {fetchedAt ? (
        <div className="text-tx3 font-mono">fetched {fetchedAt}</div>
      ) : null}
    </span>
  );
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            role="img"
            aria-label={label}
            className="inline-block rounded-full align-middle"
            style={{
              width: size,
              height: size,
              background: colorMap[state],
              boxShadow: `0 0 0 3px ${ringMap[state]}`,
            }}
          />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-50 rounded-[8px] border border-bd2 bg-s3 px-3 py-2 shadow-[var(--sh-popover)]"
          >
            {tip}
            <Tooltip.Arrow className="fill-s3" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
