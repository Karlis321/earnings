import type { Expectation } from "@/lib/types";
import clsx from "clsx";

const STYLE: Record<
  Expectation,
  { label: string; cls: string; aria: string }
> = {
  below: {
    label: "Below expectation",
    cls: "bg-[rgba(180,35,24,0.08)] border-[rgba(180,35,24,0.24)] text-danger",
    aria: "Below expectation",
  },
  inline: {
    label: "Inline",
    cls: "bg-s3 border-bd2 text-tx2",
    aria: "Inline with expectation",
  },
  above: {
    label: "Above expectation",
    cls: "bg-[rgba(18,183,106,0.10)] border-[rgba(18,183,106,0.24)] text-success-fg",
    aria: "Above expectation",
  },
  unset: {
    label: "Unset",
    cls: "bg-s3 border-bd2 text-tx-mid",
    aria: "Expectation not set",
  },
};

export function ExpectationTag({ expectation }: { expectation: Expectation }) {
  const s = STYLE[expectation];
  return (
    <span
      className={clsx(
        "inline-flex h-[22px] items-center rounded-[5px] border px-[9px] text-[10.5px]",
        s.cls,
      )}
      aria-label={s.aria}
    >
      {s.label}
    </span>
  );
}
