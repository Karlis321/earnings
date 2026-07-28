// Reaction horizon maturation — turns pending ReactionPoints into computed
// abs + excess returns once enough sessions have elapsed.
//
// Trading calendar is derived from the security's own returned bars (DC7);
// horizon offsets are counted in trading sessions:
//   d1 = 1 session after baseline
//   d3 = 3 sessions
//   w1 = 5 sessions (one trading week)
//   m1 = ~21 sessions (one trading month)
//
// Baseline anchor rule (already reflected in event.reaction.baselineDate):
//   BMO → event day close, AMC → next session close.
//
// Failure modes:
//   - Yahoo lookup / bars fail → error logged, points stay pending
//   - Benchmark bars missing → gapFlagged=true, absReturn still computed
//   - Delisting → point.gapFlagged=true with a note (deferred to caller)

import type {
  EventRecord,
  Entity,
  Horizon,
  ReactionPoint,
} from "@/lib/types";
import { yahooLookup, yahooSeries } from "@/server/vendors/yahoo";

const OFFSETS: Record<Horizon, number> = {
  d1: 1,
  d3: 3,
  w1: 5,
  m1: 21,
};

// Common benchmark string → Yahoo symbol. Falls back to a direct search
// for anything not in this map.
const BENCHMARK_MAP: Record<string, string> = {
  SOX: "^SOX",
  SPX: "^GSPC",
  NDX: "^NDX",
  RUT: "^RUT",
  DAX: "^GDAXI",
  FTSE: "^FTSE",
  N225: "^N225",
  BOVESPA: "^BVSP",
  IBOV: "^BVSP",
  TSX: "^GSPTSE",
  "HG=F": "HG=F",
  "GC=F": "GC=F",
  "SI=F": "SI=F",
  "CL=F": "CL=F",
  URA: "URA",
  XLE: "XLE",
  XLK: "XLK",
};

async function resolveYahooSymbol(bloombergTicker: string): Promise<string | null> {
  const [sym, exch = "US"] = bloombergTicker.split(/\s+/);
  const r = await yahooLookup(sym, exch);
  if ("error" in r) return null;
  return r.yahooSymbol;
}

async function resolveBenchmark(benchmark: string): Promise<string | null> {
  if (!benchmark) return null;
  if (BENCHMARK_MAP[benchmark]) return BENCHMARK_MAP[benchmark];
  // Try as-is (e.g. Yahoo-native symbols like "HG=F")
  return benchmark;
}

interface Bar {
  date: string; // YYYY-MM-DD
  close: number;
}

function findBaselineIndex(bars: Bar[], baselineDate: string): number {
  // Match on ISO date prefix. If exact miss, take the first bar on or
  // after baselineDate — Yahoo may skip holidays.
  const exact = bars.findIndex((b) => b.date === baselineDate);
  if (exact >= 0) return exact;
  const target = new Date(baselineDate).getTime();
  return bars.findIndex((b) => new Date(b.date).getTime() >= target);
}

interface Result {
  updated: EventRecord;
  matured: Horizon[];
  errors: string[];
}

// Given an anchor date and timing rule, find the baseline close bar.
//   BMO → event day close (first bar on or after anchor)
//   AMC → next session close (first bar strictly after anchor)
//   null → default to BMO behavior
function pickBaselineIdx(
  bars: Bar[],
  anchorDate: string,
  timing: EventRecord["timing"],
): number {
  const anchorTs = new Date(anchorDate).getTime();
  if (timing === "AMC") {
    return bars.findIndex((b) => new Date(b.date).getTime() > anchorTs);
  }
  return bars.findIndex((b) => new Date(b.date).getTime() >= anchorTs);
}

export async function matureEventReaction(
  event: EventRecord,
  entity: Entity,
  // Same-ticker past events used to flag contamination — if a newer
  // event lands inside a horizon window, that horizon's price move
  // mixes two earnings reactions and gets `contaminated: true`.
  // Caller passes the ticker's group of events (self OK — we skip
  // matches on id/eventDate == current).
  siblings: EventRecord[] = [],
): Promise<Result> {
  const now = new Date();
  const anchor = event.eventDate ?? event.scheduledDate;
  const anchorHasPassed = anchor && new Date(anchor).getTime() <= now.getTime();

  const pending = event.reaction.points.filter(
    (p) =>
      p.absReturn === null &&
      p.populatesOn &&
      new Date(p.populatesOn) <= now,
  );
  const needsBaseline =
    (!event.reaction.baselineDate || event.reaction.baselineClose === null) &&
    anchorHasPassed;

  if (pending.length === 0 && !needsBaseline) {
    return { updated: event, matured: [], errors: [] };
  }

  // Prefer the persisted yahooSymbol on the entity — yahooLookup is
  // search-based and fails for foreign tickers (SHLE CN → SHLE.TO,
  // IJ / KS / IN listings) where the search endpoint doesn't return
  // the correct listing. Fall back to the search only when we have
  // no persisted symbol.
  const secSymbol =
    entity.yahooSymbol ?? (await resolveYahooSymbol(entity.ticker));
  if (!secSymbol) {
    return {
      updated: event,
      matured: [],
      errors: [`yahoo resolve failed for ${entity.ticker}`],
    };
  }
  const secBars = (await yahooSeries(secSymbol, "3mo")) as Bar[];
  if (secBars.length === 0) {
    // Decay rule (Part 6): if the event's report date is >60 trading days
    // in the past (~90 calendar days) and we STILL cannot fetch baseline
    // bars, stamp every unresolved horizon `unavailable` so the pipeline
    // report's `reactions_pending` counter drops the ones that will never
    // mature. Older events with no `status` field default to `pending`.
    const anchorTs = anchor ? new Date(anchor).getTime() : null;
    const isOld =
      anchorTs !== null &&
      (now.getTime() - anchorTs) / 86_400_000 > 90;
    if (isOld) {
      const stampedPoints: ReactionPoint[] = event.reaction.points.map((p) => {
        if (p.absReturn !== null) return p;
        return {
          ...p,
          status: "unavailable",
          computedAt: now.toISOString(),
        };
      });
      return {
        updated: {
          ...event,
          reaction: { ...event.reaction, points: stampedPoints },
        },
        matured: [],
        errors: [`no security bars for ${secSymbol} — decayed to unavailable`],
      };
    }
    return {
      updated: event,
      matured: [],
      errors: [`no security bars for ${secSymbol}`],
    };
  }

  // Seed baseline from bars when the event is past and no baseline yet.
  let baselineDate = event.reaction.baselineDate;
  let baselineClose = event.reaction.baselineClose;
  if (needsBaseline) {
    const idx = pickBaselineIdx(secBars, anchor, event.timing);
    if (idx >= 0) {
      baselineDate = secBars[idx].date;
      baselineClose = secBars[idx].close;
    }
  }

  if (!baselineDate || baselineClose === null) {
    return {
      updated:
        needsBaseline && event.reaction.baselineDate !== baselineDate
          ? {
              ...event,
              reaction: {
                ...event.reaction,
                baselineDate,
                baselineClose,
              },
            }
          : event,
      matured: [],
      errors: ["no baseline — cannot mature (bars not yet available)"],
    };
  }
  const secBaseIdx = findBaselineIndex(secBars, baselineDate);
  if (secBaseIdx < 0) {
    return {
      updated: event,
      matured: [],
      errors: [`baseline ${baselineDate} not in ${secSymbol} bars`],
    };
  }

  // Benchmark bars — best-effort. If missing, still mature abs but flag gap.
  const benchSymbol = await resolveBenchmark(entity.benchmark);
  let benchBars: Bar[] = [];
  let benchBaseIdx = -1;
  if (benchSymbol) {
    benchBars = (await yahooSeries(benchSymbol, "3mo")) as Bar[];
    if (benchBars.length > 0) {
      benchBaseIdx = findBaselineIndex(benchBars, baselineDate);
    }
  }

  // Precompute newer siblings inside each horizon window to flag contamination.
  // A "newer" sibling has eventDate strictly after this event's eventDate and
  // its eventDate falls inside [baselineDate, baselineDate + horizon trading days].
  // Since we don't have exact horizon-end calendar dates here, we compute the
  // effective end bar's date per horizon after the fact.
  const currentAnchorTs = new Date(anchor).getTime();
  const newerSiblings = siblings.filter((s) => {
    if (s.id === event.id) return false;
    if (s.ticker !== event.ticker) return false;
    const sDate = s.eventDate;
    if (!sDate) return false;
    return new Date(sDate).getTime() > currentAnchorTs;
  });

  const errors: string[] = [];
  const matured: Horizon[] = [];
  const nextPoints: ReactionPoint[] = event.reaction.points.map((p) => {
    if (p.absReturn !== null) return p;
    if (!p.populatesOn || new Date(p.populatesOn) > now) return p;

    const offset = OFFSETS[p.horizon];
    let secIdx = secBaseIdx + offset;
    let clipped = false;
    if (secIdx >= secBars.length) {
      // Horizon extends past the last available bar. If the last bar is
      // at least 1 session past baseline, clip to it and mark. Otherwise
      // keep pending (Yahoo is genuinely behind — not something to fabricate).
      const lastIdx = secBars.length - 1;
      if (lastIdx > secBaseIdx) {
        secIdx = lastIdx;
        clipped = true;
      } else {
        return p;
      }
    }
    const secClose = secBars[secIdx].close;
    const absReturn = (secClose - baselineClose) / baselineClose;

    let excessReturn: number | null = null;
    let gapFlagged = false;
    if (benchBaseIdx >= 0 && benchBars[benchBaseIdx] != null) {
      let benchIdx = benchBaseIdx + offset;
      if (benchIdx >= benchBars.length) {
        // Clip benchmark too so excess still computes off a comparable window.
        if (benchBars.length - 1 > benchBaseIdx) {
          benchIdx = benchBars.length - 1;
        } else {
          benchIdx = -1;
        }
      }
      if (benchIdx >= 0) {
        const benchBase = benchBars[benchBaseIdx].close;
        const benchClose = benchBars[benchIdx].close;
        const benchAbs = (benchClose - benchBase) / benchBase;
        excessReturn = absReturn - benchAbs;
      } else {
        gapFlagged = true;
      }
    } else {
      gapFlagged = true;
    }

    // Contamination check: any newer sibling event whose eventDate falls
    // between baselineDate (exclusive — the current event's own baseline)
    // and the horizon-end bar's date (inclusive) mixes reactions.
    const horizonEndDate = secBars[secIdx].date;
    const baselineTs = new Date(baselineDate!).getTime();
    const endTs = new Date(horizonEndDate).getTime();
    let contaminated = false;
    for (const sib of newerSiblings) {
      const sTs = new Date(sib.eventDate!).getTime();
      if (sTs > baselineTs && sTs <= endTs) {
        contaminated = true;
        break;
      }
    }

    matured.push(p.horizon);
    return {
      ...p,
      absReturn,
      excessReturn,
      computedAt: now.toISOString(),
      gapFlagged: gapFlagged || undefined,
      clipped: clipped || undefined,
      contaminated: contaminated || undefined,
      status: clipped ? "clipped" : "matured",
    };
  });

  const baselineChanged =
    baselineDate !== event.reaction.baselineDate ||
    baselineClose !== event.reaction.baselineClose;

  if (matured.length === 0 && !baselineChanged) {
    return { updated: event, matured, errors };
  }

  return {
    updated: {
      ...event,
      reaction: {
        ...event.reaction,
        baselineDate,
        baselineClose,
        points: nextPoints,
      },
    },
    matured,
    errors,
  };
}
