"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "@/providers/ThemeProvider";
import { usePersistence } from "@/providers/PersistenceProvider";
import { StalenessLegend } from "@/components/primitives/StalenessLegend";
import { GlobalSearch } from "./GlobalSearch";
import { DataStatusPill } from "./DataStatusPill";
import { Moon, Sun, ContrastIcon } from "lucide-react";
import clsx from "clsx";
import { FEATURE_FLAGS } from "@/lib/flags";

const TABS = [
  { href: "/", label: "Overview" },
  { href: "/sectors", label: "Sectors", flagged: "sectors" as const },
  { href: "/admin", label: "Admin" },
];

export function Header() {
  const path = usePathname();
  const { theme, cycle } = useTheme();
  const { status } = usePersistence();
  return (
    <header
      className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-bd px-10 backdrop-blur-md"
      style={{ background: "var(--bg-blur)" }}
    >
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 text-tx">
          <span
            className="h-[22px] w-[22px] rounded-[6px]"
            style={{
              background:
                "linear-gradient(150deg, var(--brand-hi), var(--brand-lo))",
            }}
            aria-hidden="true"
          />
          <span className="text-[14px] font-semibold">Signal</span>
          <span className="ml-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-tx3">
            Earnings & Catalyst Dashboard
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
                  "rounded-button px-3 py-[6px] text-[13px]",
                  active
                    ? "bg-s3 font-medium text-tx"
                    : "text-tx2 hover:text-tx",
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
        <StalenessLegend compact />
        <DataStatusPill />
        <button
          onClick={cycle}
          className="rounded-button border border-bd bg-panel p-2 text-tx-mid hover:text-tx"
          aria-label={`Theme: ${theme}. Click to cycle.`}
        >
          {theme === "light" ? (
            <Sun size={14} />
          ) : theme === "dim" ? (
            <ContrastIcon size={14} />
          ) : (
            <Moon size={14} />
          )}
        </button>
        <span
          className="flex items-center gap-[7px] rounded-button border border-bd bg-panel px-3 py-[6px] text-[12px] text-tx2"
          aria-live="polite"
        >
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{
              background:
                status === "synced"
                  ? "#34d399"
                  : status === "syncing"
                  ? "#fbbf24"
                  : "#f87171",
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
