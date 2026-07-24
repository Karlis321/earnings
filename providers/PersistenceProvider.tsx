"use client";

// Commit-pipe status (Synced / Syncing / Local only) — P3 fills in the real
// optimistic-write + localStorage merge. Right now this drives the header pill.
// Backend integration flag: syncing to /api/shared-state via GH_PAT is P3-live.

import { createContext, useContext, useMemo, useState } from "react";

export type PipeStatus = "synced" | "syncing" | "local";

interface PersistenceCtx {
  status: PipeStatus;
  banner: null | "local-only" | "stale-refresh";
  markSyncing: () => void;
  markSynced: () => void;
  markLocal: () => void;
}

const Ctx = createContext<PersistenceCtx>({
  status: "synced",
  banner: null,
  markSyncing: () => undefined,
  markSynced: () => undefined,
  markLocal: () => undefined,
});

export function PersistenceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<PipeStatus>("synced");
  const value = useMemo<PersistenceCtx>(
    () => ({
      status,
      banner:
        status === "local"
          ? "local-only"
          : null,
      markSyncing: () => setStatus("syncing"),
      markSynced: () => setStatus("synced"),
      markLocal: () => setStatus("local"),
    }),
    [status],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePersistence() {
  return useContext(Ctx);
}
