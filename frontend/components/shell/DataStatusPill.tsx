"use client";

import Link from "next/link";
import { useHealth } from "@/lib/useHealth";

// Reflects the last cron run (falls back to the snapshot timestamp when
// the cron hasn't reported yet). Colored dot flips green / warning / danger
// based on `lastCronOk` and staleness.

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DataStatusPill() {
  const { health } = useHealth();
  const iso = health?.lastCronRun ?? health?.snapshotAt ?? null;
  const stamp = iso ? formatStamp(iso) : "—";
  const label = health?.lastCronRun ? "Cron" : "Snapshot";

  let dot = "bg-tx3";
  if (health) {
    if (health.lastCronOk === false) dot = "bg-danger";
    else if (health.lastCronRun) {
      const hours =
        (Date.now() - new Date(health.lastCronRun).getTime()) / 3_600_000;
      dot = hours > (health.staleThresholdHours ?? 26) ? "bg-warning" : "bg-success";
    } else {
      dot = "bg-tx3"; // no cron yet
    }
  }

  return (
    <Link
      href="/settings"
      className="flex items-center gap-[7px] rounded-button border border-bd bg-panel px-3 py-[6px] text-[12px] text-tx2 hover:text-tx"
      aria-label={`${label} last ran at ${stamp}`}
    >
      <span className={`h-[7px] w-[7px] rounded-full ${dot}`} aria-hidden="true" />
      {label} {stamp}
    </Link>
  );
}
