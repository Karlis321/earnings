"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePersistence } from "@/providers/PersistenceProvider";
import { StalenessLegend } from "@/components/primitives/StalenessLegend";
import { GlobalSearch } from "./GlobalSearch";
import { DataStatusPill } from "./DataStatusPill";
import { SendEmailButton } from "./SendEmailButton";
import clsx from "clsx";
import { FEATURE_FLAGS } from "@/lib/flags";

const TABS = [
  { href: "/", label: "Overview" },
  { href: "/week-ahead", label: "Week ahead" },
  { href: "/ideas", label: "Ideas" },
  { href: "/screens", label: "Screens" },
  { href: "/news", label: "News" },
  { href: "/sectors", label: "Sectors", flagged: "sectors" as const },
  { href: "/admin", label: "Admin" },
];

export function Header() {
  const path = usePathname();
  const { status } = usePersistence();
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
            return (
              <Link
                key={t.href}
                href={t.href}
                className={clsx(
                  "rounded-button px-3 py-[6px] text-[13px] transition-colors",
                  active
                    ? "bg-s3 font-medium text-tx"
                    : "text-tx2 hover:bg-hover hover:text-tx",
                )}
              >
                {t.label}
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
