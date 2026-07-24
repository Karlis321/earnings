import type { GuidanceMove } from "@/lib/types";
import clsx from "clsx";

const STYLE: Record<
  Exclude<GuidanceMove, null>,
  { icon: string; label: string; cls: string; aria: string }
> = {
  raised: {
    icon: "↑",
    label: "Raised",
    cls: "text-[#4ade80] bg-[rgba(52,211,153,0.12)]",
    aria: "Guidance raised",
  },
  held: {
    icon: "→",
    label: "Held",
    cls: "text-tx2 bg-s3",
    aria: "Guidance held",
  },
  cut: {
    icon: "↓",
    label: "Cut",
    cls: "text-danger bg-[rgba(248,113,113,0.12)]",
    aria: "Guidance cut",
  },
  initiated: {
    icon: "✦",
    label: "Initiated",
    cls: "text-brand-fg bg-[rgba(47,127,255,0.12)]",
    aria: "Guidance initiated",
  },
  withdrawn: {
    icon: "⊘",
    label: "Withdrawn",
    cls: "text-tx-mid bg-s3",
    aria: "Guidance withdrawn",
  },
};

export function GuidanceMoveBadge({ move }: { move: GuidanceMove }) {
  if (move === null) {
    return <span className="text-[12px] text-tx3">—</span>;
  }
  const s = STYLE[move];
  return (
    <span
      className={clsx(
        "inline-flex h-6 items-center gap-[5px] rounded-[6px] px-[10px] text-[11.5px]",
        s.cls,
      )}
      aria-label={s.aria}
    >
      <span aria-hidden="true">{s.icon}</span>
      {s.label}
    </span>
  );
}
