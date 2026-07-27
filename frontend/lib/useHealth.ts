"use client";

import { useEffect, useState } from "react";
import { api } from "./apiClient";
import type { EngineStatus, Horizon } from "./types";

export interface HealthSnapshot {
  ok: boolean;
  snapshotAt: string;
  schema: string;
  events: number;
  mode: string;
  ghPatPresent: boolean;
  lastCronRun: string | null;
  lastCronOk: boolean | null;
  cronDurationMs: number | null;
  engines: EngineStatus[];
  totalAppended: number;
  totalMatured: number;
  cronEventSummaries: Array<{
    eventId: string;
    ticker: string;
    appended: number;
    maturedHorizons: Horizon[];
    errors: string[];
  }>;
  staleThresholdHours: number;
}

// Fetches /api/health once on mount. Cheap enough to call from any
// client component that needs the current freshness state.
export function useHealth() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getHealth()
      .then((h) => {
        if (!cancelled) setHealth(h as unknown as HealthSnapshot);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { health, error };
}

// True when now - lastCronRun > staleThresholdHours on a weekday.
// Weekend stale is not banner-worthy (no scheduled cron runs).
export function isStaleRefresh(health: HealthSnapshot | null): boolean {
  if (!health?.lastCronRun) return false;
  const dow = new Date().getUTCDay();
  const isWeekday = dow >= 1 && dow <= 5;
  if (!isWeekday) return false;
  const hours =
    (Date.now() - new Date(health.lastCronRun).getTime()) / 3_600_000;
  return hours > (health.staleThresholdHours ?? 26);
}
