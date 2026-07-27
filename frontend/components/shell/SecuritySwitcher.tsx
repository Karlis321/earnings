"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import type { Entity } from "@/lib/types";
import { TypeBadge } from "@/components/primitives";
import { ChevronDown } from "lucide-react";

export function SecuritySwitcher({ currentTicker }: { currentTicker: string }) {
  const router = useRouter();
  const [list, setList] = useState<Entity[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .getEntities()
      .then((r) => {
        if (!cancelled) setList(r);
      })
      .catch(() => {
        /* Header switcher stays empty on fetch failure — not fatal. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Header switcher shows the portfolio (isCore) only. Full universe
  // browsing lives on /admin and /admin/expand. If the current page is
  // on a non-core ticker (e.g. reached from a link), pin it into the
  // dropdown so switching back is one click.
  const current = list.find((e) => e.ticker === currentTicker);
  const dropdownList = (() => {
    const core = list.filter((e) => e.isCore);
    if (current && !current.isCore) {
      return [current, ...core];
    }
    return core;
  })();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex h-8 items-center gap-2 rounded-button border border-bd bg-panel px-3 text-[12.5px] text-tx hover:text-tx">
          <span className="font-mono text-brand-fg">{current?.ticker}</span>
          <span className="text-tx-mid">·</span>
          <span>{current?.displayName}</span>
          <ChevronDown size={12} className="text-tx-mid" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-[320px] w-[300px] overflow-y-auto rounded-panel border border-bd2 bg-s2 p-[6px] shadow-[var(--sh-popover)]"
        >
          {dropdownList.map((e) => (
            <DropdownMenu.Item
              key={e.ticker}
              onSelect={() =>
                router.push(`/s/${encodeURIComponent(e.ticker)}`)
              }
              className="flex cursor-pointer items-center justify-between rounded-button px-2 py-[7px] text-[13px] outline-none focus:bg-hover"
            >
              <span className="flex items-center gap-2">
                <TypeBadge type={e.securityType} size="sm" />
                <span className="font-mono text-[11px] text-brand-fg">
                  {e.ticker}
                </span>
                <span className="text-tx">{e.displayName}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
