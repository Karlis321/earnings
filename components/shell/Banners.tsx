"use client";

import { usePersistence } from "@/providers/PersistenceProvider";
import { AlertTriangle, WifiOff } from "lucide-react";

// Global banners: local-only + stale-refresh. Toggle-driven for now;
// P3 fires them off real 503/409 events + cron staleness.

export function Banners() {
  const { banner } = usePersistence();
  if (!banner) return null;
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
  return (
    <div className="flex items-center gap-3 border-b border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.08)] px-10 py-2 text-[12.5px] text-warning">
      <AlertTriangle size={13} />
      Daily refresh hasn't run in over 24 hours — figures may lag.
    </div>
  );
}
