"use client";

import type { FactSource } from "@/lib/types";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { ExternalLink } from "lucide-react";

export function DeepLinkButton({
  source,
  label = "View source",
  size = "sm",
}: {
  source: FactSource;
  label?: string;
  size?: "sm" | "md";
}) {
  const { openSource } = useSourceViewer();
  const h = size === "md" ? "h-9" : "h-7";
  const px = size === "md" ? "px-3" : "px-[10px]";
  const text = size === "md" ? "text-[13px]" : "text-[11.5px]";
  return (
    <button
      className={`inline-flex items-center gap-[6px] rounded-button border border-bd2 bg-s2 text-tx2 hover:bg-s3 hover:text-tx ${h} ${px} ${text}`}
      onClick={() => openSource({ kind: "fact", source })}
    >
      <ExternalLink size={12} aria-hidden="true" />
      {label}
    </button>
  );
}
