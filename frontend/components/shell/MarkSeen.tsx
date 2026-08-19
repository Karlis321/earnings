"use client";

// One-shot "mark this ticker as seen" stamp for the 1D new-transcript
// alert. Writes localStorage on mount when the user opens a ticker's
// detail page — the WatchlistTable then reads the same key on the
// overview grid to gate the "+N new" badge.
//
// Key format: `sig-seen:<TICKER>` → ISO datetime string.
// Storage is client-only (single-user personal dashboard); no server
// round-trip and no cross-device sync needed.

import { useEffect } from "react";

interface Props {
  ticker: string;
  // The latest source-item timestamp from the shard at page-render
  // time. Stored so a later visit knows the exact "state at last
  // view", not just "some time in the past". Optional — when no
  // items exist for this ticker yet, we still stamp "now" so the
  // badge doesn't fire for zero-source tickers.
  latestItemAt?: string;
}

export function MarkSeen({ ticker, latestItemAt }: Props) {
  useEffect(() => {
    try {
      const key = `sig-seen:${ticker}`;
      // Prefer the shard's latestItemAt so subsequent visits know the
      // exact watermark; fall back to now for empty-source tickers.
      const value = latestItemAt ?? new Date().toISOString();
      window.localStorage.setItem(key, value);
    } catch {
      // localStorage disabled / quota exceeded / SSR mismatch — silent.
    }
  }, [ticker, latestItemAt]);

  return null;
}
