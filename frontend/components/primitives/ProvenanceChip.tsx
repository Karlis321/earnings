import type { Provenance } from "@/lib/types";
import clsx from "clsx";

const STYLE: Record<Provenance, { label: string; cls: string }> = {
  regulatory: {
    label: "Regulatory",
    cls: "bg-[rgba(105,65,198,0.08)] border-[rgba(105,65,198,0.28)] text-dev-fg",
  },
  "ir-page": {
    label: "IR page",
    cls: "bg-[rgba(47,127,255,0.08)] border-[rgba(47,127,255,0.28)] text-brand-fg",
  },
  wire: {
    label: "Wire",
    cls: "bg-[rgba(6,118,71,0.08)] border-[rgba(6,118,71,0.26)] text-etf-fg",
  },
  news: { label: "News", cls: "bg-s3 border-bd2 text-tx2" },
  social: {
    label: "Social",
    cls: "bg-[rgba(23,92,211,0.08)] border-[rgba(23,92,211,0.28)] text-social-fg",
  },
  independent: {
    label: "Independent",
    cls: "bg-s3 border-bd2 text-tx-mid",
  },
};

export function ProvenanceChip({ provenance }: { provenance: Provenance }) {
  const s = STYLE[provenance];
  return (
    <span
      className={clsx(
        "inline-flex h-[22px] items-center rounded-[5px] border px-[9px] text-[10.5px] font-medium",
        s.cls,
      )}
      aria-label={`Source provenance: ${s.label}`}
    >
      {s.label}
    </span>
  );
}
