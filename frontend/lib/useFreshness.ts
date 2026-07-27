"use client";

import { useEffect, useState } from "react";
import { computeFreshness, todayIso } from "./freshness";

// Recompute freshness on focus per FE PRD §9 — never store it.
// P3-T2.
export function useLiveFreshness(asOf: string | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    const onFocus = () => tick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    const iv = window.setInterval(onFocus, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(iv);
    };
  }, []);
  return computeFreshness(asOf ?? null, todayIso());
}
