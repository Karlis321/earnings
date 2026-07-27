"use client";

// Global search / ⌘K palette. Typeahead against the entity registry loaded
// from /api/entity-registry on mount. Unknown-ticker resolution still needs
// /api/ticker-lookup wiring — falls through to a "no matches" hint today.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import type { Entity } from "@/lib/types";
import { Search } from "lucide-react";
import { TypeBadge } from "@/components/primitives";

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(0);
  const [entities, setEntities] = useState<Entity[]>([]);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getEntities()
      .then((r) => {
        if (!cancelled) setEntities(r);
      })
      .catch(() => {
        /* Search stays empty on fetch failure. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return entities.slice(0, 6);
    return entities
      .filter(
        (e) =>
          e.ticker.toLowerCase().includes(term) ||
          e.displayName.toLowerCase().includes(term) ||
          e.aliases.some((a) => a.toLowerCase().includes(term)),
      )
      .slice(0, 8);
  }, [q, entities]);

  const go = (ticker: string) => {
    setOpen(false);
    setQ("");
    router.push(`/s/${encodeURIComponent(ticker)}`);
  };

  return (
    <>
      <button
        className="flex h-8 items-center gap-2 rounded-button border border-bd bg-s1 px-3 text-[12.5px] text-tx3 hover:text-tx"
        onClick={() => setOpen(true)}
      >
        <Search size={13} aria-hidden="true" />
        <span>Search ticker or name</span>
        <span className="ml-2 rounded-[4px] border border-bd bg-s3 px-[6px] py-[1px] font-mono text-[10px] text-tx2">
          ⌘K
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="mx-auto mt-24 w-[540px] overflow-hidden rounded-panel border border-bd2 bg-s2 shadow-[var(--sh-popover)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-bd p-3">
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSelected(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSelected((s) => Math.min(s + 1, filtered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSelected((s) => Math.max(s - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const pick = filtered[selected];
                    if (pick) go(pick.ticker);
                  }
                }}
                placeholder="Jump to security or event…"
                className="h-9 w-full bg-transparent px-2 text-[13.5px] text-tx outline-none placeholder:text-tx-mid"
              />
            </div>
            <div className="max-h-[360px] overflow-y-auto p-[6px]">
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-[13px] text-tx-mid">
                  No matches in your covered names.
                  <div className="mt-1 font-mono text-[11px] text-tx-faint">
                    unknown-ticker resolution: /api/ticker-lookup (todo)
                  </div>
                </div>
              ) : (
                filtered.map((e, i) => (
                  <button
                    key={e.ticker}
                    onClick={() => go(e.ticker)}
                    className={`flex w-full items-center justify-between rounded-button px-[10px] py-2 text-left text-[13px] ${
                      i === selected
                        ? "bg-[rgba(47,127,255,0.12)]"
                        : "hover:bg-hover"
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <TypeBadge type={e.securityType} size="sm" />
                      <span className="font-mono text-[11.5px] text-brand-fg">
                        {e.ticker}
                      </span>
                      <span className="text-tx">{e.displayName}</span>
                    </span>
                    <span className="text-[11px] text-tx-mid">⏎</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
