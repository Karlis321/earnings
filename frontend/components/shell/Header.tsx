"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { usePersistence } from "@/providers/PersistenceProvider";
import { StalenessLegend } from "@/components/primitives/StalenessLegend";
import { GlobalSearch } from "./GlobalSearch";
import { DataStatusPill } from "./DataStatusPill";
import { SendEmailButton } from "./SendEmailButton";
import clsx from "clsx";
import { FEATURE_FLAGS } from "@/lib/flags";

// Each tab optionally declares a `freshKey` that maps into the
// `freshness` prop below. When the server-side timestamp is newer
// than the localStorage watermark stamped on last visit, a small
// dot renders next to the label.
type FreshKey = "weekAhead" | "themes" | "screens";
const TABS: Array<{
  href: string;
  label: string;
  flagged?: "sectors";
  freshKey?: FreshKey;
}> = [
  { href: "/", label: "Overview" },
  { href: "/week-ahead", label: "Week ahead", freshKey: "weekAhead" },
  { href: "/themes", label: "Themes", freshKey: "themes" },
  { href: "/screens", label: "Screens", freshKey: "screens" },
  { href: "/ideas", label: "Ideas" },
  { href: "/correlation", label: "Correlation" },
  { href: "/news", label: "News" },
  { href: "/sectors", label: "Sectors", flagged: "sectors" },
  { href: "/admin", label: "Admin" },
];

// LocalStorage keys mirror the routes so the read/write is
// self-documenting. Values are ISO strings — the moment the user
// last visited that route.
const NAV_SEEN_PREFIX = "sig-nav-seen:";

interface Freshness {
  weekAhead: string | null;
  themes: string | null;
  screens: string | null;
}

export function Header({ freshness }: { freshness: Freshness }) {
  const path = usePathname();
  const { status } = usePersistence();

  // Ticker → last-visit ISO, hydrated once from localStorage on
  // mount so SSR + first-paint never render the dot spuriously.
  const [seen, setSeen] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const out: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith(NAV_SEEN_PREFIX)) continue;
        const v = window.localStorage.getItem(k);
        if (v) out[k.slice(NAV_SEEN_PREFIX.length)] = v;
      }
      setSeen(out);
    } catch {
      /* localStorage disabled — dots simply never fire. */
    }
  }, []);

  // Stamp the current route as seen every time the path changes.
  // Matches the same-day-visit + long-tail idempotence used by
  // MarkSeen on the ticker detail page.
  useEffect(() => {
    if (!path) return;
    // Only track routes with a freshKey — no reason to litter
    // localStorage with /admin / /news visits.
    const tab = TABS.find(
      (t) => t.freshKey && (t.href === "/" ? path === "/" : path.startsWith(t.href)),
    );
    if (!tab) return;
    try {
      const now = new Date().toISOString();
      window.localStorage.setItem(NAV_SEEN_PREFIX + tab.href, now);
      setSeen((s) => ({ ...s, [tab.href]: now }));
    } catch {
      /* ignore */
    }
  }, [path]);
  return (
    <header
      className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-bd px-10 backdrop-blur-md"
      style={{ background: "var(--bg-blur)" }}
    >
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 text-tx">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.avif"
            alt="Signal"
            width={28}
            height={28}
            className="h-[28px] w-[28px] rounded-[6px] object-cover"
          />
          <span className="text-[15px] font-semibold text-tx">Signal</span>
          <span className="ml-3 text-[10.5px] font-medium uppercase tracking-[0.14em] text-tx3">
            Earnings & Catalyst
          </span>
        </Link>

        <nav className="flex items-center gap-[4px]" aria-label="Primary">
          {TABS.map((t) => {
            if (t.flagged && !FEATURE_FLAGS[t.flagged]) return null;
            const active =
              t.href === "/" ? path === "/" : path.startsWith(t.href);
            // Fresh-data dot: server timestamp is newer than the
            // route's last-visit watermark (or never visited).
            const serverTs = t.freshKey ? freshness[t.freshKey] : null;
            const localTs = seen[t.href];
            const hasFresh = !!serverTs && (!localTs || serverTs > localTs);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={clsx(
                  "relative rounded-button px-3 py-[6px] text-[13px] transition-colors",
                  active
                    ? "bg-s3 font-medium text-tx"
                    : "text-tx2 hover:bg-hover hover:text-tx",
                )}
              >
                {t.label}
                {hasFresh ? (
                  <span
                    aria-label={`${t.label} has new content`}
                    title={`Updated ${serverTs.slice(0, 16).replace("T", " ")}Z — click to view`}
                    className="absolute right-[6px] top-[6px] inline-block h-[6px] w-[6px] rounded-full bg-brand"
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-3">
        <GlobalSearch />
        <SendEmailButton />
        <StalenessLegend compact />
        <DataStatusPill />
        <span
          className="flex items-center gap-[7px] rounded-button border border-bd bg-s1 px-3 py-[6px] text-[12px] text-tx2"
          aria-live="polite"
        >
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{
              background:
                status === "synced"
                  ? "var(--success)"
                  : status === "syncing"
                  ? "var(--warning)"
                  : "var(--danger)",
            }}
          />
          {status === "synced"
            ? "Synced"
            : status === "syncing"
            ? "Syncing…"
            : "Local only"}
        </span>
      </div>
    </header>
  );
}
