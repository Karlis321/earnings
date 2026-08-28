"use client";

// "new since your last visit" hook — rolling two-slot timestamp.
//
// Persistence lives on `preferences.lastVisit` in shared-state. On
// first mount of the session we:
//   1. Read `preferences.lastVisit.current` (from the last session)
//      and use it as our CUTOFF.
//   2. Stamp `preferences.lastVisit = { previous: <old current>, current: <now> }`
//      so the next session inherits our current-visit time.
//
// Firing the PATCH is fire-and-forget: the cutoff is derived from the
// value the server already had, so a failed PATCH still gives the user
// the right badges for THIS session — it just doesn't roll for next.
//
// If lastVisit is null (never set), cutoff stays null and callers
// treat "isNew" as false → no badges on first-ever visit. Prevents
// the "everything is new" flood.

import { useEffect, useState } from "react";
import type { SharedState } from "@/lib/types";

const SESSION_KEY = "signal-last-visit-cutoff";

export interface LastVisitState {
  cutoff: string | null;
  ready: boolean;
}

export function useLastVisit(): LastVisitState {
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // If we've already rolled in this browser session, reuse the
    // cutoff we captured then — otherwise a hard navigation between
    // pages would keep re-stamping and marking events seen too fast.
    const cached = typeof window !== "undefined"
      ? window.sessionStorage.getItem(SESSION_KEY)
      : null;
    if (cached !== null) {
      setCutoff(cached === "" ? null : cached);
      setReady(true);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/shared-state", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const state: SharedState = await res.json();
        const priorCurrent = state.preferences?.lastVisit?.current ?? null;
        if (!cancelled) {
          setCutoff(priorCurrent);
          setReady(true);
          window.sessionStorage.setItem(SESSION_KEY, priorCurrent ?? "");
        }
        // Roll: previous <- old current, current <- now.
        if (state.preferences) {
          const nowIso = new Date().toISOString();
          const nextState: SharedState = {
            ...state,
            preferences: {
              ...state.preferences,
              lastVisit: { previous: priorCurrent, current: nowIso },
            },
          };
          await fetch("/api/shared-state", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextState),
          }).catch(() => {}); // fire-and-forget
        }
      } catch {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { cutoff, ready };
}

export function isNewSince(iso: string | null | undefined, cutoff: string | null): boolean {
  if (!iso || !cutoff) return false;
  return iso > cutoff;
}
