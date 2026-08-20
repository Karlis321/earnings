"use client";

// Small "← Back to /ideas" chip shown on /s/[ticker] when the
// user arrived from one of the AI-signal list surfaces. Reads
// document.referrer on mount — silent when unavailable (external
// nav, referrer stripped, direct URL entry).

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Same-origin path prefixes we recognize as valid "return to"
// destinations. Extending this array is the only wiring needed
// to add a new surface (e.g. /screens future subpaths).
const KNOWN_ORIGINS: Array<{ prefix: string; label: string }> = [
  { prefix: "/ideas", label: "Ideas" },
  { prefix: "/screens", label: "Screens" },
  { prefix: "/week-ahead", label: "Week ahead" },
  { prefix: "/sectors", label: "Sectors" },
];

export function ReturnChip() {
  const [origin, setOrigin] = useState<{ href: string; label: string } | null>(
    null,
  );

  useEffect(() => {
    try {
      const ref = document.referrer;
      if (!ref) return;
      const url = new URL(ref);
      // Same-origin check — no phishing risk from arbitrary links.
      if (url.origin !== window.location.origin) return;
      // Reject same-page reloads and other /s/[t] pages.
      if (url.pathname.startsWith("/s/")) return;
      // Match the longest known prefix.
      const match = KNOWN_ORIGINS.find((k) =>
        url.pathname.startsWith(k.prefix),
      );
      if (!match) return;
      setOrigin({
        // Preserve the exact URL including query — so returning
        // to /ideas?ticker=<T> takes the user back to the right
        // deep-link position (row still highlighted).
        href: url.pathname + url.search,
        label: match.label,
      });
    } catch {
      // Malformed referrer / SSR / storage disabled — silent.
    }
  }, []);

  if (!origin) return null;

  return (
    <Link
      href={origin.href}
      className="inline-flex h-7 items-center gap-1.5 rounded-button border border-bd bg-s1 px-3 text-[12px] text-tx-mid hover:bg-hover hover:text-tx"
    >
      <ArrowLeft size={12} />
      <span>Back to {origin.label}</span>
    </Link>
  );
}
