"use client";

// $0 mode: heuristic news/opinion — the "heuristic" note appears in the tooltip
// per FE PRD §6. Real LLM classification unlocks when Anthropic enrichment is on
// (backend integration flag: needs ANTHROPIC_API_KEY + api/news enrichment step).

import * as Tooltip from "@radix-ui/react-tooltip";
import type { ArticleType } from "@/lib/types";
import clsx from "clsx";

export function ArticleTypeBadge({ type }: { type: ArticleType }) {
  const cls =
    type === "opinion"
      ? "bg-[rgba(251,191,36,0.12)] border-[rgba(251,191,36,0.28)] text-warning"
      : "bg-s3 border-bd2 text-tx2";
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            className={clsx(
              "inline-flex h-[22px] items-center rounded-[5px] border px-[9px] text-[10.5px] cursor-default",
              cls,
            )}
            aria-label={`Article type: ${type === "opinion" ? "opinion" : "news"} (heuristic)`}
          >
            {type === "opinion" ? "Opinion" : "News"}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-50 max-w-[220px] rounded-[8px] border border-bd2 bg-s3 px-3 py-2 text-[11.5px] shadow-[var(--sh-popover)]"
          >
            Heuristic classification · $0 mode. Full LLM classification unlocks
            when enrichment is enabled.
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
