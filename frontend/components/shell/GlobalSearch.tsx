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

  // Group listings under one row per company. Search matches on ANY
  // member ticker or name — so searching "GOGL34" still surfaces the
  // Alphabet row — but we return only the canonical listing plus a
  // count of siblings, so "nvidia" gives 1 row not 4.
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    // Index entities by companyId once so we can attach listing counts.
    const byCompany = new Map<string, Entity[]>();
    for (const e of entities) {
      const cid = e.companyId ?? e.ticker;
      if (!byCompany.has(cid)) byCompany.set(cid, []);
      byCompany.get(cid)!.push(e);
    }
    // Empty query: default to the first N canonical listings (matches
    // watchlist ordering: portfolio picks first).
    const canonical = (list: Entity[]) => list.find((e) => e.isCanonical) ?? list[0];
    if (!term) {
      return [...byCompany.values()]
        .map((list) => ({ hit: canonical(list), listings: list }))
        .slice(0, 6);
    }
    // Match any member listing; return the canonical of the matched
    // company. Dedup so the same company doesn't appear twice via two
    // matching member tickers.
    //
    // Ranking (Part 5b): exact ticker match wins the top slot regardless
    // of cap. Otherwise sort by the company's marketCapUsd descending —
    // so "micro" surfaces Microsoft above Micron above nano-caps. The
    // canonical listing carries the cap value; non-canonicals don't
    // affect ordering because they never enter the result set.
    const upperTerm = q.trim().toUpperCase();
    const seenCompanies = new Set<string>();
    interface Hit { hit: Entity; listings: Entity[]; exactTicker: boolean; cap: number; }
    const hits: Hit[] = [];
    for (const e of entities) {
      const matches =
        e.ticker.toLowerCase().includes(term) ||
        e.displayName.toLowerCase().includes(term) ||
        e.aliases.some((a) => a.toLowerCase().includes(term));
      if (!matches) continue;
      const cid = e.companyId ?? e.ticker;
      if (seenCompanies.has(cid)) continue;
      seenCompanies.add(cid);
      const list = byCompany.get(cid) ?? [e];
      const canon = canonical(list);
      // Exact ticker match test — matches the full Bloomberg ticker
      // ("TGB US") OR the base symbol ("TGB") of any member listing.
      // A raw query typed as just "TGB" should match tickers like
      // "TGB US" / "TGB CN" — split on whitespace and compare the base.
      const isExact = list.some((m) => {
        const parts = m.ticker.split(/\s+/);
        return (
          m.ticker.toUpperCase() === upperTerm ||
          parts[0]?.toUpperCase() === upperTerm
        );
      });
      hits.push({
        hit: canon,
        listings: list,
        exactTicker: isExact,
        cap: canon.marketCapUsd ?? 0,
      });
    }
    hits.sort((a, b) => {
      // Exact ticker match always ranks first
      if (a.exactTicker !== b.exactTicker) return a.exactTicker ? -1 : 1;
      // Then by market cap desc — Microsoft (2.9T) above Micron (100B)
      // above nano-caps
      return b.cap - a.cap;
    });
    return hits.slice(0, 8).map(({ hit, listings }) => ({ hit, listings }));
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
                    if (pick) go(pick.hit.ticker);
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
                filtered.map(({ hit, listings }, i) => {
                  const extra = listings.length - 1;
                  return (
                    <button
                      key={hit.companyId ?? hit.ticker}
                      onClick={() => go(hit.ticker)}
                      className={`flex w-full items-center justify-between rounded-button px-[10px] py-2 text-left text-[13px] ${
                        i === selected
                          ? "bg-[rgba(47,127,255,0.12)]"
                          : "hover:bg-hover"
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <TypeBadge type={hit.securityType} size="sm" />
                        <span className="font-mono text-[11.5px] text-brand-fg">
                          {hit.ticker}
                        </span>
                        <span className="text-tx">{hit.displayName}</span>
                        {extra > 0 ? (
                          <span
                            className="rounded-[4px] bg-s3 px-[5px] py-[1px] font-mono text-[10px] text-tx2"
                            title={listings.map((l) => l.ticker).join(", ")}
                          >
                            +{extra} listings
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[11px] text-tx-mid">⏎</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
