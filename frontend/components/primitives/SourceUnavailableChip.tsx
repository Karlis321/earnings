import type { Engine } from "@/lib/types";
import { X } from "lucide-react";

export function SourceUnavailableChip({
  engine,
  reason,
  lastGood,
}: {
  engine: Engine | string;
  reason?: string;
  lastGood?: string;
}) {
  return (
    <span
      role="status"
      className="inline-flex h-6 items-center gap-[6px] rounded-[6px] border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.12)] px-[10px] text-[11.5px] text-danger"
    >
      <X size={11} aria-hidden="true" />
      {engine.toString().toUpperCase()} unavailable
      {reason ? ` — ${reason}` : ""}
      {lastGood ? (
        <span className="text-tx3">· last good {lastGood.slice(11, 16)}</span>
      ) : null}
    </span>
  );
}
