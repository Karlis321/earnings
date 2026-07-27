"use client";

// Commit-pipe status (Synced / Syncing / Local only). Writes optimistically
// mark syncing and settle to synced (git-commit succeeded) or local
// (persistence-unavailable — GH_PAT missing, viewer stays on device state).

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
