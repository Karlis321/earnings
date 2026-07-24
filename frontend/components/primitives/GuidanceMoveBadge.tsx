import type { GuidanceMove } from "@/lib/types";
import clsx from "clsx";

const STYLE: Record<
  Exclude<GuidanceMove, null>,
  { icon: string; label: string; cls: string; aria: string }
> = {
  raised: {
    icon: "↑",
    label: "Raised",
    cls: "text-success-fg bg-[rgba(18,183,106,0.10)] border-[rgba(18,183,106,0.28)]",
    aria: "Guidance raised",
  },
  held: {
    icon: "→",
    label: "Held",
    cls: "text-tx2 bg-s3 border-bd2",
    aria: "Guidance held",
  },
  cut: {
    icon: "↓",
    label: "Cut",
    cls: "text-danger bg-[rgba(180,35,24,0.08)] border-[rgba(180,35,24,0.28)]",
    aria: "Guidance cut",
  },
  initiated: {
    icon: "✦",
    label: "Initiated",
    cls: "text-brand-fg bg-[rgba(47,127,255,0.08)] border-[rgba(47,127,255,0.28)]",
    aria: "Guidance initiated",
  },
  withdrawn: {
    icon: "⊘",
    label: "Withdrawn",
    cls: "text-tx-mid bg-s3 border-bd2",
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
        "inline-flex h-6 items-center gap-[5px] rounded-[6px] border px-[10px] text-[11.5px] font-medium",
        s.cls,
      )}
      aria-label={s.aria}
    >
      <span aria-hidden="true">{s.icon}</span>
      {s.label}
    </span>
  );
}
