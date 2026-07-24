import type { Provenance } from "@/lib/types";
import clsx from "clsx";

const STYLE: Record<Provenance, { label: string; cls: string }> = {
  regulatory: {
    label: "Regulatory",
    cls: "bg-[rgba(129,140,248,0.14)] border-[rgba(129,140,248,0.3)] text-dev-fg",
  },
  "ir-page": {
    label: "IR page",
    cls: "bg-[rgba(47,127,255,0.14)] border-[rgba(47,127,255,0.3)] text-brand-fg",
  },
  wire: {
    label: "Wire",
    cls: "bg-[rgba(45,212,191,0.14)] border-[rgba(45,212,191,0.3)] text-etf-fg",
  },
  news: { label: "News", cls: "bg-s3 border-bd2 text-tx2" },
  social: {
    label: "Social",
    cls: "bg-[rgba(96,165,250,0.10)] border-[rgba(96,165,250,0.24)] text-social-fg",
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
        "inline-flex h-[22px] items-center rounded-[5px] border px-[9px] text-[10.5px]",
        s.cls,
      )}
      aria-label={`Source provenance: ${s.label}`}
    >
      {s.label}
    </span>
  );
}
