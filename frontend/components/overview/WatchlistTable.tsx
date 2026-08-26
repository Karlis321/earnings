"use client";

// The analyst home screen — dense sortable type-aware table.
// Filter/sort bar per FE PRD §7.2 (P4-T2).
// Row states: recent-event highlight, data-incomplete, unscheduled (P4-T3).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { WatchlistRow, SecurityType } from "@/lib/types";
import {
  SurprisePill,
  FreshnessDot,
  StalenessLegend,
  ReactionRow,
} from "@/components/primitives";
import { TickerLogo } from "@/components/primitives/TickerLogo";
import {
  RealPriceSparkline,
  PriceDeltaLabel,
} from "./RealPriceSparkline";
import { fmtDaysUntil, fmtDateShort } from "@/lib/format";
import { daysUntil as daysUntilFn } from "@/lib/freshness";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import clsx from "clsx";
import { WatchlistFilterPopover } from "./WatchlistFilterPopover";

// Server response shape from /api/prices/bulk
interface BulkPriceEntry {
  ok: boolean;
  series: { date: string; close: number }[];
  pctChange?: number;
  latest?: number;
  first?: number;
  change?: number;
  err?: string;
}
interface BulkPricesResponse {
  range: string;
  fetchedAt: string;
  tickers: Record<string, BulkPriceEntry>;
}

interface BulkEarningsEntry {
  ok: boolean;
  data?: {
    nextEarningsDate: string | null;
    lastQuarter: {
      period: string;
      actual: number | null;
      estimate: number | null;
      surprisePct: number | null;
    } | null;
  };
  err?: string;
}
interface BulkEarningsResponse {
  fetchedAt: string;
  tickers: Record<string, BulkEarningsEntry>;
}

// Industry buckets — sectorTag → industry group. The registry tags are
// a mix of Yahoo-screener top-level names ("technology", "materials",
// "healthcare", "financial-services", ...) and older fine-grained tags
// from the manual portfolio setup ("copper", "gold", "uranium", "ai").
// Each bucket needle list includes both so a filter tab matches
// regardless of which vintage populated the entity.
const INDUSTRY_GROUPS: Record<string, string[]> = {
  portfolio: [], // special: matches all core rows
  technology: ["technology", "semiconductors", "ai", "hardware", "software"],
  materials: [
    "materials",
    "mining",
    "copper",
    "gold",
    "silver",
    "aluminum",
    "iron-ore",
    "lithium",
    "commodities",
  ],
  energy: [
    "energy",
    "uranium",
    "oil",
    "gas",
    "oil-gas",
    "oil-gas-services",
    "renewables",
  ],
  healthcare: ["healthcare"],
  financials: [
    "financials",
    "financial-services",
    "exchanges",
    "alternative-asset-management",
  ],
  consumer: ["consumer-cyclical", "consumer-defensive"],
  industrials: ["industrials"],
  communications: ["communication-services"],
  realestate: ["real-estate"],
  utilities: ["utilities"],
  developer: ["developer"],
};

type Filter =
  | "focus"
  | "portfolio"
  | "sp500"
  | "r1000"
  | "technology"
  | "materials"
  | "energy"
  | "healthcare"
  | "financials"
  | "consumer"
  | "industrials"
  | "communications"
  | "realestate"
  | "utilities"
  | "developer";
// Fixed sort keys + a dynamic "metric:<key>:<dim>:<dir>" form. The
// dynamic form lets the user sort by any metric present on visible
// rows (e.g. revenue_usd_m, capex_total, buyback_qtr_usd). Dim is
// "value" (raw actual) or "surprise" (surprisePct); dir is "desc"
// or "asc". Parsed at sort time in the switch below.
type FixedSortKey =
  | "cap"
  | "cap-asc"
  | "winners-1m"
  | "losers-1m"
  | "next"
  | "surprise"
  | "surprise-rev"
  | "reaction"
  | "reaction-d3"
  | "reaction-d3-excess"
  | "reaction-w1"
  | "reaction-m1"
  | "reaction-loss"
  | "reaction-loss-d3"
  | "reaction-loss-w1"
  | "reaction-loss-m1"
  | "freshness"
  | "name";
type SortKey = FixedSortKey | `metric:${string}:${"value" | "surprise"}:${"desc" | "asc"}`;
type Group =
  | "flat"
  | "type"
  | "sector"
  | "industry"
  | "cap-industry"
  | "cap-band-desc"
  | "cap-band-asc";
const CAP_TIER_ORDER: Array<"mega" | "large" | "mid" | "small" | "unknown"> = [
  "mega",
  "large",
  "mid",
  "small",
  "unknown",
];
const CAP_TIER_LABEL: Record<string, string> = {
  mega: "Mega cap · ≥$200B",
  large: "Large cap · $10B–$200B",
  mid: "Mid cap · $2B–$10B",
  small: "Small cap · $250M–$2B",
  unknown: "Nano / unknown",
};
type TierFilter = "any" | "mega" | "large" | "mid" | "small" | "unknown";

// Per-sector headline metric priority. When columnMetric === "__auto__",
// each row picks the first metric from ITS sector's list that has data.
// Falls back to eps_usd → revenue_usd_m if no sector-specific match.
// Sector tags come from entity.sectorTags; the first tag wins.
const SECTOR_HEADLINE_METRICS: Record<string, string[]> = {
  // "mining" is the extended-registry tag; "materials" is the GICS
  // sector tag most miners actually carry in entity.sectorTags. Both
  // resolve to the same priority list.
  mining: ["aisc_gold", "c1_cash_cost", "production_cu_kt", "production_au_koz"],
  materials: ["aisc_gold", "c1_cash_cost", "production_cu_kt", "production_au_koz"],
  financials: ["nim", "rotce", "cet1_ratio", "efficiency_ratio"],
  software: ["arr", "ndr", "crpo", "rpo_total"],
  technology: ["arr", "ndr", "crpo"],
  "consumer-cyclical": ["comp_sales_pct", "ecomm_growth_pct"],
  "consumer-defensive": ["comp_sales_pct", "organic_sales_pct"],
  energy: ["production_boed", "realized_price_bbl"],
  "oil-gas": ["production_boed", "realized_price_bbl"],
  healthcare: ["gross_margin_pct", "rd_pct_revenue"],
  industrials: ["backlog_usd", "book_to_bill"],
  "real-estate": ["nav_per_share", "occupancy_pct", "same_store_noi_pct"],
  utilities: ["rate_base_growth_pct"],
};
const DEFAULT_HEADLINE_FALLBACK = ["eps_usd", "revenue_usd_m"];

/** Resolve the headline metric key for a row given its sectorTags. */
function pickRowHeadlineMetric(
  row: WatchlistRow,
): { key: string; label: string; value: number; unit: string | null; surprisePct: number | null } | null {
  const metrics = row.latestMetrics ?? {};
  const tags = row.entity.sectorTags ?? [];
  // Try sector-specific priorities first.
  for (const tag of tags) {
    const prio = SECTOR_HEADLINE_METRICS[tag];
    if (!prio) continue;
    for (const k of prio) {
      const m = metrics[k];
      if (m?.value != null) return { key: k, ...m };
    }
  }
  // Fallback to standard.
  for (const k of DEFAULT_HEADLINE_FALLBACK) {
    const m = metrics[k];
    if (m?.value != null) return { key: k, ...m };
  }
  return null;
}

export function WatchlistTable({
  rows,
  focusTickers = [],
  frameworkByTicker = {},
}: {
  rows: WatchlistRow[];
  // Prioritized subset from user preferences. Empty when the user
  // hasn't set any yet — component falls back to portfolio as the
  // default filter in that case.
  focusTickers?: string[];
  // Ticker → framework composite scores (bo = Blue Ocean, rb =
  // Rule Breaker) from data/screens/*.json. Optional — chips
  // only render when data exists (auto-hidden while
  // framework-screen workflow hasn't fired for a ticker).
  frameworkByTicker?: Record<string, { bo?: number; rb?: number }>;
}) {
  const router = useRouter();
  const focusSet = useMemo(() => new Set(focusTickers), [focusTickers]);
  const [filter, setFilter] = useState<Filter>(
    focusTickers.length > 0 ? "focus" : "portfolio",
  );
  // Ticker → last-visit ISO watermark read from localStorage. Empty on
  // first render (SSR-safe); populated once on client mount from every
  // `sig-seen:*` key. Used by <Row hasNewSinceVisit /> to render the
  // "new" pill only when the shard's latestItemAt is strictly after
  // the stored watermark.
  const [lastSeenMap, setLastSeenMap] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const out: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith("sig-seen:")) continue;
        const t = k.slice("sig-seen:".length);
        const v = window.localStorage.getItem(k);
        if (v) out[t] = v;
      }
      setLastSeenMap(out);
    } catch {
      // localStorage disabled — badge simply never fires. Not a bug.
    }
  }, []);
  const [sortKey, setSortKey] = useState<SortKey>("next");
  const [reportingSoon, setReportingSoon] = useState(false);
  const [group, setGroup] = useState<Group>("flat");
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [tier, setTier] = useState<TierFilter>("any");
  // Reset keyboard cursor whenever the visible row set changes. Without
  // this, applying a filter that shrinks the list can leave selectedIdx
  // pointing past the new bounds, and switching group modes reorders
  // rows so the previous selectedIdx highlights the wrong row.
  useEffect(() => {
    setSelectedIdx(0);
  }, [filter, tier, reportingSoon, group, sortKey]);
  // Canonical-listings-only by default — so NVIDIA counts once in
  // large-cap tech instead of four times (once per BDR / MM / TB / CN
  // wrapper listing). Portfolio rows (isCore) always show regardless,
  // so the 17 covered tickers are never hidden even if a rare one
  // happens not to be canonical of its company group.
  const [showAllListings, setShowAllListings] = useState(false);
  // Metric-column selector. The "Industry-specific metric" column shows
  // this metric's surprise% (or value, if no surprise) per row.
  //
  // Special value "__auto__" = per-row sector-picked metric. Each row
  // picks its own headline via SECTOR_HEADLINE_METRICS priority list
  // (mining → AISC / C1 / production; financials → NIM / ROTCE;
  // software → ARR / NDR; etc.), falling back to EPS surprise when no
  // sector-specific data is present. This is the default so users see
  // industry-relevant metrics per row out of the box.
  const [columnMetric, setColumnMetric] = useState<string>("__auto__");
  // Sibling-listing counts per company — used for the "+N listings"
  // badge on canonical rows and to expose the hidden members via title.
  const listingsByCompany = useMemo(() => {
    const m = new Map<string, WatchlistRow[]>();
    for (const r of rows) {
      const cid = r.entity.companyId ?? r.entity.ticker;
      if (!m.has(cid)) m.set(cid, []);
      m.get(cid)!.push(r);
    }
    return m;
  }, [rows]);

  // Real 1-month prices + Yahoo earnings, fetched in parallel on mount.
  const [prices, setPrices] = useState<BulkPricesResponse | null>(null);
  const [pricesLoading, setPricesLoading] = useState(true);
  const [earnings, setEarnings] = useState<BulkEarningsResponse | null>(null);

  useEffect(() => {
    // Chunk the ticker list into batches of 100 so the GET URL stays
    // under browser + Vercel query-string limits (~8KB) and each Vercel
    // function invocation completes under the 30s cap (~2s/ticker at
    // Yahoo concurrency 4 → 50s per batch of 100 max, in practice much
    // less because most tickers hit Yahoo's cache). Batches run in
    // parallel; results merge progressively so partial data is visible
    // before every batch finishes.
    const BATCH_SIZE = 100;
    const allTickers = rows.map((r) => r.ticker);
    const batches: string[][] = [];
    for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
      batches.push(allTickers.slice(i, i + BATCH_SIZE));
    }
    let cancelled = false;
    const merged: BulkPricesResponse = {
      range: "1mo",
      fetchedAt: new Date().toISOString(),
      tickers: {},
    };
    const mergedEarnings: BulkEarningsResponse = {
      fetchedAt: new Date().toISOString(),
      tickers: {},
    };
    let completed = 0;
    Promise.all(
      batches.map(async (chunk) => {
        const q = encodeURIComponent(chunk.join(","));
        const [pj, ej] = await Promise.all([
          fetch(`/api/prices/bulk?tickers=${q}&range=1mo`, { cache: "no-store" })
            .then((r) => (r.ok ? (r.json() as Promise<BulkPricesResponse>) : null))
            .catch(() => null),
          fetch(`/api/earnings/yahoo/bulk?tickers=${q}`, { cache: "no-store" })
            .then((r) => (r.ok ? (r.json() as Promise<BulkEarningsResponse>) : null))
            .catch(() => null),
        ]);
        if (cancelled) return;
        if (pj?.tickers) {
          Object.assign(merged.tickers, pj.tickers);
          setPrices({ ...merged, tickers: { ...merged.tickers } });
        }
        if (ej?.tickers) {
          Object.assign(mergedEarnings.tickers, ej.tickers);
          setEarnings({ ...mergedEarnings, tickers: { ...mergedEarnings.tickers } });
        }
        completed++;
        if (completed === batches.length) setPricesLoading(false);
      }),
    ).catch(() => {
      if (!cancelled) setPricesLoading(false);
    });
    return () => { cancelled = true; };
    // Fetch once on mount — ticker list is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    let list = rows.slice();
    if (filter === "focus") {
      // Focus filter — user-selected priority subset from preferences.
      // If the set is empty (user hasn't configured yet), degrade to
      // showing portfolio so the panel isn't blank.
      list = list.filter((r) =>
        focusSet.size > 0 ? focusSet.has(r.ticker) : r.entity.isCore,
      );
    } else if (filter === "portfolio") {
      // Portfolio = core watchlist (17 tickers from prompt1.txt).
      // Sector-universe entities (isCore:false) live under the tab
      // labels below and on /admin.
      list = list.filter((r) => r.entity.isCore);
    } else if (filter === "sp500") {
      // Index membership filter — SP500 is NOT a sector, so we can't
      // use sectorTags here. Constituents keep their real GICS
      // sectors + industry groups; this filter just narrows the
      // universe to the 503 flagged in the daily reference file.
      list = list.filter((r) => (r.entity.index_membership ?? []).includes("SP500"));
    } else if (filter === "r1000") {
      // Same idea for Russell 1000. Superset of SP500 (about 1,013
      // constituents); companies keep their real industry group.
      list = list.filter((r) => (r.entity.index_membership ?? []).includes("R1000"));
    } else {
      const needles = INDUSTRY_GROUPS[filter] ?? [];
      list = list.filter((r) => {
        if (filter === "developer") return r.entity.securityType === "developer";
        return r.entity.sectorTags.some((t) => needles.includes(t));
      });
    }
    if (reportingSoon) {
      list = list.filter(
        (r) => r.nextEvent.daysUntil !== null && r.nextEvent.daysUntil <= 14,
      );
    }
    if (tier !== "any") {
      list = list.filter((r) => (r.entity.capTier ?? "unknown") === tier);
    }
    if (!showAllListings) {
      // Canonical-only default. isCore is a hard OVERRIDE — the 17
      // covered tickers always show even if the audit picked a
      // different member as canonical of their company (rare, but
      // preserves the "don't remap" invariant from the prompt).
      list = list.filter((r) => r.entity.isCanonical || r.entity.isCore);
    }
    list.sort((a, b) => {
      // Dynamic "metric:<key>:<dim>:<dir>" sort — check prefix before
      // falling through to the fixed switch below.
      if (sortKey.startsWith("metric:")) {
        const parts = sortKey.split(":");
        const key = parts[1];
        const dim = parts[2]; // "value" | "surprise"
        const dir = parts[3]; // "desc" | "asc"
        const av = dim === "surprise"
          ? a.latestMetrics?.[key]?.surprisePct ?? (dir === "asc" ? Infinity : -Infinity)
          : a.latestMetrics?.[key]?.value ?? (dir === "asc" ? Infinity : -Infinity);
        const bv = dim === "surprise"
          ? b.latestMetrics?.[key]?.surprisePct ?? (dir === "asc" ? Infinity : -Infinity)
          : b.latestMetrics?.[key]?.value ?? (dir === "asc" ? Infinity : -Infinity);
        return dir === "asc" ? av - bv : bv - av;
      }
      switch (sortKey as FixedSortKey) {
        case "next":
          return (
            (a.nextEvent.daysUntil ?? 999) - (b.nextEvent.daysUntil ?? 999)
          );
        case "surprise":
          return (b.lastSurprisePct ?? -Infinity) - (a.lastSurprisePct ?? -Infinity);
        case "surprise-rev":
          return (b.lastRevenueSurprisePct ?? -Infinity) - (a.lastRevenueSurprisePct ?? -Infinity);
        case "reaction": {
          // Default reaction sort = d1 winners
          const av = a.reactionPoints?.find((p) => p.horizon === "d1")?.absReturn ?? -Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "d1")?.absReturn ?? -Infinity;
          return bv - av;
        }
        case "reaction-d3": {
          const av = a.reactionPoints?.find((p) => p.horizon === "d3")?.absReturn ?? -Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "d3")?.absReturn ?? -Infinity;
          return bv - av;
        }
        case "reaction-d3-excess": {
          // Quick-Sort pill: excess return at d3 (vs assigned benchmark).
          // Rows without a d3 point OR without excessReturn on that
          // point sink to the bottom.
          const av = a.reactionPoints?.find((p) => p.horizon === "d3")?.excessReturn ?? -Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "d3")?.excessReturn ?? -Infinity;
          return bv - av;
        }
        case "reaction-w1": {
          const av = a.reactionPoints?.find((p) => p.horizon === "w1")?.absReturn ?? -Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "w1")?.absReturn ?? -Infinity;
          return bv - av;
        }
        case "reaction-m1": {
          const av = a.reactionPoints?.find((p) => p.horizon === "m1")?.absReturn ?? -Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "m1")?.absReturn ?? -Infinity;
          return bv - av;
        }
        case "reaction-loss": {
          const av = a.reactionPoints?.find((p) => p.horizon === "d1")?.absReturn ?? Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "d1")?.absReturn ?? Infinity;
          return av - bv;
        }
        case "reaction-loss-d3": {
          const av = a.reactionPoints?.find((p) => p.horizon === "d3")?.absReturn ?? Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "d3")?.absReturn ?? Infinity;
          return av - bv;
        }
        case "reaction-loss-w1": {
          const av = a.reactionPoints?.find((p) => p.horizon === "w1")?.absReturn ?? Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "w1")?.absReturn ?? Infinity;
          return av - bv;
        }
        case "reaction-loss-m1": {
          const av = a.reactionPoints?.find((p) => p.horizon === "m1")?.absReturn ?? Infinity;
          const bv = b.reactionPoints?.find((p) => p.horizon === "m1")?.absReturn ?? Infinity;
          return av - bv;
        }
        case "freshness": {
          const order = { fresh: 0, overdue: 1, stale: 2, never: 3 } as const;
          return order[a.freshness] - order[b.freshness];
        }
        case "name":
          return a.entity.displayName.localeCompare(b.entity.displayName);
        case "cap":
          return (b.entity.marketCapUsd ?? 0) - (a.entity.marketCapUsd ?? 0);
        case "cap-asc":
          return (a.entity.marketCapUsd ?? 0) - (b.entity.marketCapUsd ?? 0);
        case "winners-1m": {
          // Biggest 1M gainers first — reads live prices from state.
          // Tickers without a prices entry (loading or errored) sink
          // to the bottom via -Infinity.
          const ap = prices?.tickers[a.ticker];
          const bp = prices?.tickers[b.ticker];
          const av = ap?.ok && typeof ap.pctChange === "number" ? ap.pctChange : -Infinity;
          const bv = bp?.ok && typeof bp.pctChange === "number" ? bp.pctChange : -Infinity;
          return bv - av;
        }
        case "losers-1m": {
          const ap = prices?.tickers[a.ticker];
          const bp = prices?.tickers[b.ticker];
          const av = ap?.ok && typeof ap.pctChange === "number" ? ap.pctChange : Infinity;
          const bv = bp?.ok && typeof bp.pctChange === "number" ? bp.pctChange : Infinity;
          return av - bv;
        }
      }
    });
    return list;
  }, [rows, filter, reportingSoon, sortKey, tier, prices, focusSet]);

  const grouped = useMemo(() => {
    if (group === "flat") {
      // "Group: market cap ↓" mode — one flat panel, largest US caps
      // first regardless of the sort dropdown. The user's other sort
      // choices apply inside grouped modes (per-group ordering).
      const sortedByCap = [...filtered].sort(
        (a, b) => (b.entity.marketCapUsd ?? 0) - (a.entity.marketCapUsd ?? 0),
      );
      return [{ id: "", label: "", rows: sortedByCap }];
    }

    // "cap-industry" mode: two-level grouping — cap tier at the top,
    // industry group underneath. We flatten to a single-level list so
    // the existing render loop keeps working, but the labels are
    // constructed as "<Cap band> · <Industry group>". Cap bands sort
    // in fixed order (mega→large→mid→small→unknown); industries within
    // a band sort by row count desc so the biggest sub-groups surface
    // first.
    // "cap-band-desc" / "cap-band-asc" — group by cap tier only (no
    // industry sub-grouping). Within each band, rows sort by market cap
    // matching the band direction (mega group is cap-desc; nano group
    // is cap-asc when direction=asc).
    if (group === "cap-band-desc" || group === "cap-band-asc") {
      const byBand = new Map<string, WatchlistRow[]>();
      for (const r of filtered) {
        const band = (r.entity.capTier ?? "unknown") as string;
        if (!byBand.has(band)) byBand.set(band, []);
        byBand.get(band)!.push(r);
      }
      const order = group === "cap-band-asc"
        ? [...CAP_TIER_ORDER].reverse()
        : CAP_TIER_ORDER;
      const out: Array<{ id: string; label: string; rows: WatchlistRow[] }> = [];
      for (const band of order) {
        const rows = byBand.get(band);
        if (!rows || rows.length === 0) continue;
        // Sort rows within band by cap in the group's direction.
        const sorted = rows.slice().sort((a, b) =>
          group === "cap-band-asc"
            ? (a.entity.marketCapUsd ?? 0) - (b.entity.marketCapUsd ?? 0)
            : (b.entity.marketCapUsd ?? 0) - (a.entity.marketCapUsd ?? 0),
        );
        out.push({
          id: `band::${band}`,
          label: `${CAP_TIER_LABEL[band] ?? band} · ${rows.length}`,
          rows: sorted,
        });
      }
      return out;
    }

    if (group === "cap-industry") {
      const byBand = new Map<string, Map<string, WatchlistRow[]>>();
      for (const r of filtered) {
        const band = (r.entity.capTier ?? "unknown") as string;
        const ind = r.entity.industryGroup ?? "(unclassified)";
        if (!byBand.has(band)) byBand.set(band, new Map());
        const inner = byBand.get(band)!;
        if (!inner.has(ind)) inner.set(ind, []);
        inner.get(ind)!.push(r);
      }
      const out: Array<{ id: string; label: string; rows: WatchlistRow[] }> = [];
      for (const band of CAP_TIER_ORDER) {
        const inner = byBand.get(band);
        if (!inner) continue;
        const industries = [...inner.entries()].sort(
          (a, b) => b[1].length - a[1].length,
        );
        for (const [ind, rows] of industries) {
          out.push({
            id: `${band}::${ind}`,
            label: `${CAP_TIER_LABEL[band] ?? band}  ·  ${ind}`,
            rows,
          });
        }
      }
      return out;
    }

    const map = new Map<string, WatchlistRow[]>();
    for (const r of filtered) {
      const key =
        group === "type"
          ? r.entity.securityType
          : group === "industry"
          ? r.entity.industryGroup ?? "(unclassified)"
          : r.entity.sectorTags[0] ?? "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    // Sort industry / sector groups by row count desc so meaningful
    // buckets rise to the top; type stays alpha for a stable order.
    const entries = [...map.entries()];
    if (group !== "type") entries.sort((a, b) => b[1].length - a[1].length);
    return entries.map(([id, rows]) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      rows,
    }));
  }, [filtered, group]);

  // Render-order → row map. `grouped` reshuffles rows across groups —
  // e.g. sector-grouped Tech rows appear before Finance rows regardless
  // of original filter order. Keyboard-highlight and arrow-key nav must
  // use THIS ordering so selectedIdx=N highlights the N-th visible row.
  const orderedRows = useMemo(() => {
    const out: WatchlistRow[] = [];
    for (const g of grouped) out.push(...g.rows);
    return out;
  }, [grouped]);

  // Union of metric keys across the currently-visible rows. Powers the
  // dynamic "Sort by specific metric" section of the filter popover
  // AND the column-header metric selector. For every metric we track
  // both raw-value count AND surprise%-populated count — the header
  // selector hides options that have zero surprise%-populated rows,
  // since sorting by surprise on those would just null-out everyone.
  const availableMetrics = useMemo(() => {
    const freq = new Map<string, {
      count: number;
      surpriseCount: number;
      label: string;
      unit: string | null;
    }>();
    for (const r of orderedRows) {
      const rows = r.latestMetrics ?? {};
      for (const [k, m] of Object.entries(rows)) {
        const prev = freq.get(k);
        if (prev) {
          prev.count++;
          if (m.surprisePct != null) prev.surpriseCount++;
        } else {
          freq.set(k, {
            count: 1,
            surpriseCount: m.surprisePct != null ? 1 : 0,
            label: m.label,
            unit: m.unit,
          });
        }
      }
    }
    return [...freq.entries()]
      .map(([key, v]) => ({
        key,
        label: v.label,
        unit: v.unit,
        count: v.count,
        surpriseCount: v.surpriseCount,
      }))
      .sort((a, b) => b.surpriseCount - a.surpriseCount || b.count - a.count);
  }, [orderedRows]);

  return (
    <div>
      <FilterBar
        filter={filter}
        setFilter={setFilter}
        sortKey={sortKey}
        setSortKey={setSortKey}
        group={group}
        setGroup={setGroup}
        tier={tier}
        setTier={setTier}
        reportingSoon={reportingSoon}
        setReportingSoon={setReportingSoon}
        showAllListings={showAllListings}
        setShowAllListings={setShowAllListings}
        availableMetrics={availableMetrics}
      />

      <div
        // `overflow-hidden` on the container broke position:sticky for
        // the HeaderRow — sticky pins to the closest ancestor that
        // establishes a scroll container, and overflow:hidden qualifies.
        // Result: the header scrolled with the rows, and the first data
        // row could visually appear above the (no-longer-pinned) header.
        // We drop overflow-hidden; the rounded-panel border still gives
        // us clean visual edges since no child overflows its cells.
        // isolation:isolate keeps sub-tree stacking contained so no
        // absolute-positioned badge inside a row can render above the
        // sticky header (z-20 already puts the header above rows).
        className="mt-3 rounded-panel border border-bd bg-s1 [isolation:isolate]"
        role="grid"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(i + 1, orderedRows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            const r = orderedRows[selectedIdx];
            if (r) router.push(`/s/${encodeURIComponent(r.ticker)}`);
          }
        }}
      >
        <HeaderRow
          columnMetric={columnMetric}
          setColumnMetric={setColumnMetric}
          metricOptions={availableMetrics.map((m) => ({
            key: m.key,
            label: m.label,
            count: m.count,
            surpriseCount: m.surpriseCount,
          }))}
          onMetricChange={(k) => {
            // Auto mode has no single sort key — rows sort themselves
            // via pickRowHeadlineMetric. Skip auto-sort in that case.
            if (k === "__auto__") return;
            // Auto-sort by the newly-picked metric's surprise desc.
            setSortKey(`metric:${k}:surprise:desc`);
          }}
        />
        {grouped.map((g) => (
          <div key={g.id}>
            {group !== "flat" && (
              <div className="border-b border-bd bg-panel2 px-[18px] py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-tx3">
                {g.label} · {g.rows.length}
              </div>
            )}
            {g.rows.map((r, i) => (
              <Row
                key={r.ticker}
                r={r}
                priceEntry={prices?.tickers[r.ticker]}
                earningsEntry={earnings?.tickers[r.ticker]}
                pricesLoading={pricesLoading}
                selected={orderedRows.indexOf(r) === selectedIdx}
                siblingCount={(() => {
                  const cid = r.entity.companyId ?? r.entity.ticker;
                  const list = listingsByCompany.get(cid);
                  return list ? list.length - 1 : 0;
                })()}
                siblingTickers={(() => {
                  const cid = r.entity.companyId ?? r.entity.ticker;
                  const list = listingsByCompany.get(cid) ?? [];
                  return list
                    .filter((s) => s.ticker !== r.ticker)
                    .map((s) => s.ticker);
                })()}
                onClick={() =>
                  router.push(`/s/${encodeURIComponent(r.ticker)}`)
                }
                columnMetric={columnMetric}
                hasNewSinceVisit={
                  !!r.latestItemAt &&
                  (!lastSeenMap[r.ticker] ||
                    r.latestItemAt > lastSeenMap[r.ticker])
                }
                framework={frameworkByTicker[r.ticker]}
              />
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="p-8 text-center text-[13px] text-tx-mid">
            No rows match the current filters.
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-4 text-[11.5px] text-tx-mid">
        <StalenessLegend />
        <span className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.08em]">
          ↑↓ navigate · ⏎ open
        </span>
      </div>
    </div>
  );
}

interface HeaderRowProps {
  columnMetric: string;
  setColumnMetric: (m: string) => void;
  metricOptions: Array<{ key: string; label: string; count: number; surpriseCount: number }>;
  onMetricChange: (m: string) => void;
}

function HeaderRow({ columnMetric, setColumnMetric, metricOptions, onMetricChange }: HeaderRowProps) {
  // Only show options that have SOME surprise% coverage — otherwise
  // the auto-sort-by-surprise on change would just null everyone out.
  // Plus the two "Industry-specific · auto" and "EPS surprise" pinned
  // options at the top.
  const surpriseCapable = metricOptions.filter((o) => o.surpriseCount > 0);
  return (
    <div
      // z-20 keeps the header above any row content that establishes its
      // own stacking context (rounded pills, sparkline SVG etc.). Site
      // header uses z-30 so this still sits below it.
      className="sticky top-14 z-20 grid grid-cols-[2fr_1.3fr_1.1fr_1.2fr_0.7fr_0.7fr] gap-3 border-b border-bd px-[18px] py-[11px] font-mono text-[10px] uppercase tracking-[0.08em] text-tx3"
      style={{ background: "var(--panel2)" }}
    >
      <span className="text-tx2">Name ▾</span>
      <span>Next event</span>
      {/* Column-metric selector — user picks EPS surprise, revenue
          surprise, production, EBITDA, or any per-sector metric. Each
          option is a metric.key from event.metrics (including sector-
          specific ones from the extendedMetricsRegistry). Changing
          the selection auto-sorts by that metric's surprise desc,
          bubbling rows without the metric to the bottom. */}
      {/*
        Column-metric dropdown, trimmed from ~15+ options to a fixed
        3-option set. Universe-audit of latestMetrics coverage showed
        the 20+ sector-specific keys (aisc_gold, arr, nim, rotce, etc.)
        are all at 0% coverage in the events-index — they were
        aspirational, always fell through to eps_usd anyway. The three
        options below are the only ones with real, meaningful
        universal coverage:
          · auto       — per-row headline picker (fallback to eps → rev)
          · eps_usd    — 94% of operating rows
          · revenue_usd_m — 84%
      */}
      <span className="flex items-center gap-1 -my-1">
        <select
          value={columnMetric}
          onChange={(e) => {
            setColumnMetric(e.target.value);
            onMetricChange(e.target.value);
          }}
          className="h-6 max-w-full rounded-[4px] border border-bd bg-s2 px-1 font-mono text-[10px] uppercase tracking-[0.06em] text-tx2 hover:text-tx focus:border-brand/40 focus:outline-none"
          title="Auto = each row shows its own headline metric (EPS by default). Or pick EPS or Revenue explicitly."
        >
          <option value="__auto__">Auto · per-row headline</option>
          <option value="eps_usd">EPS</option>
          <option value="revenue_usd_m">Revenue</option>
        </select>
      </span>
      <span>Price · 1M</span>
      <span className="text-center">Fresh</span>
      <span className="text-right">Src</span>
    </div>
  );
}

function Row({
  r,
  onClick,
  selected,
  priceEntry,
  earningsEntry,
  pricesLoading,
  siblingCount,
  siblingTickers,
  columnMetric,
  hasNewSinceVisit,
  framework,
}: {
  r: WatchlistRow;
  onClick: () => void;
  selected: boolean;
  priceEntry?: BulkPriceEntry;
  earningsEntry?: BulkEarningsEntry;
  pricesLoading?: boolean;
  siblingCount?: number;
  siblingTickers?: string[];
  columnMetric: string;
  // True when latestItemAt > localStorage lastSeenAt[ticker]. Computed
  // once on the client after hydration and threaded down to the row.
  hasNewSinceVisit?: boolean;
  // Framework composite scores (Feature 4C). bo = Blue Ocean, rb =
  // Rule Breaker. Each optional; only renders when workflow has
  // covered the ticker.
  framework?: { bo?: number; rb?: number };
}) {
  const isDev = r.entity.securityType === "developer";
  const isEtf = r.entity.securityType === "etf";
  const yahoo = earningsEntry?.ok ? earningsEntry.data : null;
  // "Last surprise" reads as the market's reaction to the last report,
  // not the analyst beat/miss on EPS. The 3-day post-earnings absolute
  // return is the trader's surprise — SEC-vs-consensus EPS ratios are
  // often cross-basis (GAAP actual vs adjusted consensus) and mislead.
  // Fall back to the analyst compare only when we have no reaction bar
  // (foreign wrappers whose Yahoo v8 chart is empty).
  const d3 = (r.reactionPoints ?? []).find((p) => p.horizon === "d3");
  const reactionPct =
    d3 && d3.absReturn != null && (d3.status === "matured" || d3.status === "clipped")
      ? d3.absReturn * 100
      : null;
  // Column-metric surprise: reads the selected metric's surprisePct off
  // the row's latestMetrics snapshot. In "__auto__" mode, each row
  // picks its own sector-relevant metric via pickRowHeadlineMetric.
  // Falls back to legacy chain when nothing else applies. `metricMissing`
  // flags rows that don't have the current explicit metric.
  const autoPicked = columnMetric === "__auto__" ? pickRowHeadlineMetric(r) : null;
  const colMetricEntry = columnMetric === "__auto__"
    ? (autoPicked ? { ...autoPicked, key: undefined } : null)
    : r.latestMetrics?.[columnMetric];
  const columnMetricSurprise = colMetricEntry?.surprisePct ?? null;
  // Cross-basis flag on the picked metric — set by shard-earnings when
  // sanitize-basis had both sides but cleared the surprise as
  // incompatible. Drives the 'reported · basis mismatch' pill label.
  const columnMetricCrossBasisCleared =
    (colMetricEntry as { crossBasisCleared?: boolean } | null | undefined)
      ?.crossBasisCleared === true;
  const metricMissing = columnMetric !== "__auto__" && !r.latestMetrics?.[columnMetric];
  // Raw Yahoo lastQuarter.surprisePct is intentionally excluded from
  // this fallback chain. Yahoo computes surprise as (actual-est)/est
  // without any basis reconciliation, so cases like GOOGL Q2 2026
  // (SEC GAAP actual 9.11 including a $99B unrealized SpaceX gain
  // vs Yahoo analyst-consensus adjusted estimate 2.89) produce
  // meaningless numbers like +214%. Our stored r.lastSurprisePct and
  // columnMetricSurprise DO have the same-basis check applied — when
  // they're null we should render 'reported · basis mismatch' or
  // 'reported · no est', not fall through to Yahoo's raw math.
  const surprise =
    columnMetricSurprise ??
    reactionPct ??
    r.lastSurprisePct ??
    null;
  const nextIso = r.nextEvent.date ?? yahoo?.nextEarningsDate ?? null;
  // Date-only diff (via daysUntil helper) — both sides anchor at UTC
  // midnight so a same-day scheduled event reads "today", not "1d ago".
  const daysUntil = nextIso ? daysUntilFn(nextIso) : null;
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={clsx(
        "border-b border-bd last:border-b-0 transition-colors",
        selected ? "bg-hover" : "hover:bg-hover",
        r.recentEvent && "bg-[rgba(47,127,255,0.05)]",
      )}
    >
    <div
      role="row"
      tabIndex={-1}
      onClick={onClick}
      className={clsx(
        "grid cursor-pointer grid-cols-[2fr_1.3fr_1.1fr_1.2fr_0.7fr_0.7fr] items-center gap-3 px-[18px] py-3",
      )}
    >
      <div className="flex min-w-0 items-center gap-[10px]">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-label={expanded ? "Collapse reaction" : "Expand reaction"}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-hover2 text-tx3 hover:text-tx"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <TickerLogo
          ticker={r.ticker}
          name={r.entity.displayName}
          size={28}
        />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-center gap-1.5 truncate text-[13.5px] font-medium text-tx">
            <span className="truncate">{r.entity.displayName}</span>
            {metricMissing && columnMetric !== "eps_usd" ? (
              <span
                title={`This row doesn't report ${columnMetric} on its latest event. Sorted to the bottom.`}
                className="inline-flex shrink-0 items-center rounded-[3px] border border-bd bg-s2 px-[5px] font-mono text-[9px] uppercase tracking-[0.06em] text-tx-mid"
              >
                n/a
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-2 truncate font-mono text-[11px] text-tx-mid">
            {r.ticker}
            {framework?.bo != null ? (
              <span
                title="Blue Ocean framework composite (Kim/Mauborgne value-innovation, 0-100)"
                className={clsx(
                  "rounded-[4px] px-[5px] py-[1px] font-mono text-[10px] tabular-nums",
                  framework.bo >= 70
                    ? "bg-[rgba(18,183,106,0.10)] text-success-fg"
                    : framework.bo >= 50
                    ? "bg-[rgba(47,127,255,0.10)] text-brand-fg"
                    : framework.bo >= 30
                    ? "bg-s3 text-tx-mid"
                    : "bg-[rgba(180,35,24,0.10)] text-danger",
                )}
              >
                BO {framework.bo.toFixed(0)}
              </span>
            ) : null}
            {framework?.rb != null ? (
              <span
                title="Rule Breaker framework composite (Motley Fool top-dog / first-mover, 0-100)"
                className={clsx(
                  "rounded-[4px] px-[5px] py-[1px] font-mono text-[10px] tabular-nums",
                  framework.rb >= 70
                    ? "bg-[rgba(18,183,106,0.10)] text-success-fg"
                    : framework.rb >= 50
                    ? "bg-[rgba(47,127,255,0.10)] text-brand-fg"
                    : framework.rb >= 30
                    ? "bg-s3 text-tx-mid"
                    : "bg-[rgba(180,35,24,0.10)] text-danger",
                )}
              >
                RB {framework.rb.toFixed(0)}
              </span>
            ) : null}
            {siblingCount && siblingCount > 0 ? (
              <span
                className="rounded-[4px] bg-s3 px-[5px] py-[1px] text-[10px] text-tx2"
                title={
                  siblingTickers && siblingTickers.length > 0
                    ? "Also listed as: " + siblingTickers.join(", ")
                    : undefined
                }
              >
                +{siblingCount} listings
              </span>
            ) : null}
            {r.dataIncomplete ? (
              <span
                className="inline-flex items-center gap-[3px] rounded-[4px] bg-[rgba(181,71,8,0.10)] px-[5px] py-[1px] text-[10px] text-warning"
                title="Data incomplete — waiting on next refresh"
              >
                <AlertTriangle size={9} /> incomplete
              </span>
            ) : null}
          </span>
        </div>
      </div>

      <span
        className={clsx(
          "font-mono text-[12.5px]",
          daysUntil !== null && daysUntil <= 3
            ? "text-warning"
            : nextIso
            ? "text-tx-strong"
            : "text-tx3",
        )}
      >
        {nextIso ? (
          r.nextEvent.cadence === "semiannual" ||
          r.nextEvent.cadence === "annual" ? (
            // Fuzzy cadence label — the estimator only knows the month.
            <span title={nextIso}>{r.nextEvent.label}</span>
          ) : (
            <>
              {fmtDateShort(nextIso)}{" "}
              <span className="text-tx-mid">
                · {fmtDaysUntil(daysUntil)}
              </span>
            </>
          )
        ) : isEtf ? (
          "—"
        ) : (
          <span className="italic text-tx-mid">unscheduled</span>
        )}
      </span>

      <span>
        {isDev || isEtf ? (
          <span className="text-[12.5px] text-tx3">—</span>
        ) : (
          <SurprisePill
            surprisePct={surprise}
            // r.lastPeriod present means we DO have a last-print event
            // for this ticker — the actual is reported, we just may not
            // have an estimate to compare against.
            hasActual={r.lastPeriod != null}
            // When the picked metric's surprise was cleared as
            // cross-basis (SEC GAAP actual vs analyst adjusted
            // estimate), render 'reported · basis mismatch' instead of
            // 'reported · no est' — we HAD both sides, they were just
            // apples-to-oranges.
            crossBasisCleared={surprise == null && columnMetricCrossBasisCleared}
            // Y/Y revenue growth fallback for the 98% of SP500 rows
            // where a same-basis surprise isn't computable. Rendered
            // as a labeled '+X% y/y rev' chip inside SurprisePill.
            yoyRevGrowthPct={r.yoyRevenueGrowthPct}
            compact
          />
        )}
      </span>

      <span className="flex items-center gap-2">
        <RealPriceSparkline
          series={priceEntry?.series ?? []}
          loading={pricesLoading}
          err={priceEntry && !priceEntry.ok ? priceEntry.err ?? "err" : null}
        />
        <span className="flex flex-col leading-tight">
          {priceEntry?.ok && typeof priceEntry.latest === "number" ? (
            <span className="font-mono text-[12px] tabular-nums text-tx-strong">
              {priceEntry.latest >= 1000
                ? priceEntry.latest.toFixed(0)
                : priceEntry.latest.toFixed(2)}
            </span>
          ) : (
            <span className="text-[11px] text-tx3">—</span>
          )}
          <PriceDeltaLabel
            pctChange={priceEntry?.ok && typeof priceEntry.pctChange === "number"
              ? priceEntry.pctChange
              : null}
          />
        </span>
      </span>

      <span className="text-center">
        <FreshnessDot state={r.freshness} />
      </span>

      <span className="text-right font-mono text-[12.5px] text-tx-strong">
        {r.sourceCount || "—"}
        {hasNewSinceVisit ? (
          <span
            className="ml-1 rounded-[4px] bg-brand/20 px-[5px] py-[1px] text-[10px] text-brand-fg"
            title="New source items since your last visit"
          >
            new
          </span>
        ) : null}
      </span>
    </div>
    {expanded ? (
      <div className="px-[18px] pb-3 pl-[50px]">
        <ReactionRow points={r.reactionPoints ?? []} size="xs" />
      </div>
    ) : null}
    </div>
  );
}

function FilterBar({
  filter,
  setFilter,
  sortKey,
  setSortKey,
  group,
  setGroup,
  tier,
  setTier,
  reportingSoon,
  setReportingSoon,
  showAllListings,
  setShowAllListings,
  availableMetrics,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  sortKey: SortKey;
  setSortKey: (s: SortKey) => void;
  group: Group;
  setGroup: (g: Group) => void;
  tier: TierFilter;
  setTier: (t: TierFilter) => void;
  reportingSoon: boolean;
  setReportingSoon: (v: boolean) => void;
  showAllListings: boolean;
  setShowAllListings: (v: boolean) => void;
  availableMetrics: Array<{ key: string; label: string; unit: string | null; count: number; surpriseCount: number }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap rounded-button border border-bd bg-s1 p-[3px]">
        {(
          [
            { id: "focus", label: "Focus" },
            { id: "portfolio", label: "Our portfolio" },
            { id: "sp500", label: "S&P 500" },
            { id: "r1000", label: "Russell 1000" },
            { id: "technology", label: "Technology" },
            { id: "materials", label: "Materials" },
            { id: "energy", label: "Energy" },
            { id: "healthcare", label: "Healthcare" },
            { id: "financials", label: "Financials" },
            { id: "consumer", label: "Consumer" },
            { id: "industrials", label: "Industrials" },
            { id: "communications", label: "Communications" },
            { id: "realestate", label: "Real estate" },
            { id: "utilities", label: "Utilities" },
            { id: "developer", label: "Developer" },
          ] as { id: Filter; label: string }[]
        ).map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={clsx(
              "rounded-[6px] px-3 py-[5px] text-[12.5px]",
              filter === f.id
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <WatchlistFilterPopover
        sortKey={sortKey}
        setSortKey={setSortKey}
        group={group}
        setGroup={setGroup}
        tier={tier}
        setTier={setTier}
        reportingSoon={reportingSoon}
        setReportingSoon={setReportingSoon}
        showAllListings={showAllListings}
        setShowAllListings={setShowAllListings}
        availableMetrics={availableMetrics}
      />
    </div>
  );
}
