"use client";

import { usePersistence } from "@/providers/PersistenceProvider";
import { useHealth, isStaleRefresh } from "@/lib/useHealth";
import { AlertTriangle, WifiOff } from "lucide-react";

// Global banners:
//   - local-only  → write persistence fell back to localStorage (no GH_PAT)
//   - stale-refresh → cron hasn't run in > 26h on a weekday (W6)

export function Banners() {
  const { banner } = usePersistence();
  const { health } = useHealth();
  const stale = isStaleRefresh(health);

  if (banner === "local-only") {
    return (
      <div className="flex items-center gap-3 border-b border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.08)] px-10 py-2 text-[12.5px] text-warning">
        <WifiOff size={13} />
        Changes are saved on this device only. Cross-device sync paused.
        <span className="ml-auto font-mono text-[11px] text-tx-mid">
          503 · no GH_PAT
        </span>
      </div>
    );
  }
  if (banner || stale) {
    const hours = health?.lastCronRun
      ? Math.round(
          (Date.now() - new Date(health.lastCronRun).getTime()) / 3_600_000,
        )
      : null;
    return (
      <div className="flex items-center gap-3 border-b border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.08)] px-10 py-2 text-[12.5px] text-warning">
        <AlertTriangle size={13} />
        Daily refresh hasn't run in over 24 hours — figures may lag.
        {hours != null ? (
          <span className="ml-auto font-mono text-[11px] text-tx-mid">
            last cron · {hours}h ago
          </span>
        ) : null}
      </div>
    );
  }
  return null;
}
