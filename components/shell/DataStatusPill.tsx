"use client";

import Link from "next/link";
import { data } from "@/lib/data";

// Overall freshness of the last daily refresh + last-commit time.
// Backend integration flag: real freshness/probe surfaces via Data Status panel (P12-T2).

export function DataStatusPill() {
  const snapshot = data.getSnapshot();
  const d = new Date(snapshot.lastUpdated);
  const stamp = d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <Link
      href="/settings"
      className="flex items-center gap-[7px] rounded-button border border-bd bg-panel px-3 py-[6px] text-[12px] text-tx2 hover:text-tx"
      aria-label={`Last refresh at ${stamp}`}
    >
      <span
        className="h-[7px] w-[7px] rounded-full bg-success"
        aria-hidden="true"
      />
      Updated {stamp}
    </Link>
  );
}
