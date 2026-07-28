import type {
  Cadence,
  EarningsSnapshot,
  Entity,
  EventRecord,
  EventsIndexEntry,
  Freshness,
  GuidanceMove,
  WatchlistRow,
} from "@/lib/types";
import { ENTITY_REGISTRY } from "./fixtures/registry";
import { EARNINGS_FIXTURE, getLatestEvent } from "./fixtures/earnings";
import { computeFreshness, todayIso } from "./freshness";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Cadence-aware label for the next-event card. Estimator-projected dates
// for semi-annual and annual filers are only precise to the month; an
// ISO date implies confidence we don't have. For those, we render a
// fuzzy hint ("H2 · ~Feb 2027", "annual · ~Feb 2027") that matches how
// the underlying issuers actually announce.
export function formatNextEventLabel(
  nextScheduled: string,
  cadence: Cadence | undefined,
): string {
  if (cadence !== "semiannual" && cadence !== "annual") {
    return nextScheduled;
  }
  const d = new Date(nextScheduled);
  const monthName = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  if (cadence === "annual") {
    return `annual · ~${monthName} ${year}`;
  }
  const half = d.getUTCMonth() <= 5 ? "H1" : "H2";
  return `${half} · ~${monthName} ${year}`;
}

// Build the overview rows from any registry + earnings snapshot pair.
// The pure builder is what RSC pages call after fetching from the store;
// the legacy `buildWatchlist()` wrapper below keeps the fixture path alive
// for offline dev and the gallery.
export function buildWatchlistRows(
  entities: Entity[],
  snapshot: EarningsSnapshot,
  now: string,
): WatchlistRow[] {
  return entities.map((entity) => {
    const forTicker = snapshot.events.filter((e) => e.ticker === entity.ticker);
    const latest: EventRecord | undefined = forTicker
      .slice()
      .sort((a, b) =>
        (b.eventDate ?? b.scheduledDate).localeCompare(
          a.eventDate ?? a.scheduledDate,
        ),
      )[0];
    const nextUpcoming = forTicker
      .filter((e) => e.scheduledDate >= now)
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0];

    const daysUntil = nextUpcoming
      ? Math.round(
          (new Date(nextUpcoming.scheduledDate).getTime() -
            new Date(now).getTime()) /
            86400000,
        )
      : null;

    const reactionPoints = latest?.reaction.points ?? [];
    const reactionSpark = reactionPoints.map((p) => p.absReturn ?? 0);
    const reactionPending = reactionPoints.some((p) => p.absReturn === null);

    const lastSurprise = latest?.metrics.find((m) => m.isHeadline)?.surprisePct;

    const freshness: Freshness =
      entity.securityType === "etf"
        ? computeFreshness("2026-07-23", now)
        : latest
        ? computeFreshness(latest.eventDate ?? latest.scheduledDate, now)
        : "never";

    const guidanceMove: GuidanceMove =
      latest?.guidanceMove ??
      (entity.securityType === "developer" ? null : "held");

    const label =
      entity.securityType === "developer"
        ? nextUpcoming
          ? `${nextUpcoming.catalystType} · expected`
          : "unscheduled"
        : entity.securityType === "etf"
        ? "—"
        : nextUpcoming
        ? nextUpcoming.cadence === "semiannual" ||
          nextUpcoming.cadence === "annual"
          ? formatNextEventLabel(nextUpcoming.scheduledDate, nextUpcoming.cadence)
          : nextUpcoming.timing
          ? `${nextUpcoming.scheduledDate} · ${nextUpcoming.timing}`
          : nextUpcoming.scheduledDate
        : "unscheduled";

    const dataIncomplete =
      entity.securityType === "operating" && !latest;

    const recentEvent =
      !!latest &&
      Math.abs(
        (new Date(latest.eventDate ?? latest.scheduledDate).getTime() -
          new Date(now).getTime()) /
          86400000,
      ) <= 7;

    // Prefer the entity-level count (rolling 14d news + PR count),
    // fall back to summing items across all events for this ticker
    // (covers legacy data), fall back to the latest event's count.
    let sourceCount: number;
    if (typeof entity.sourceCount === "number") {
      sourceCount = entity.sourceCount;
    } else {
      const tickerEvents = snapshot.events.filter(
        (e) => e.ticker === entity.ticker,
      );
      const summed = tickerEvents.reduce(
        (acc, ev) => acc + (ev.sources?.items?.length ?? 0),
        0,
      );
      sourceCount = summed > 0 ? summed : latest?.sources.items.length ?? 0;
    }
    const newSinceLastView = latest ? Math.min(sourceCount, 2) : 0;

    return {
      ticker: entity.ticker,
      entity,
      nextEvent: {
        date: nextUpcoming?.scheduledDate ?? null,
        daysUntil,
        label,
        cadence: nextUpcoming?.cadence,
      },
      lastPeriod: latest?.period ?? null,
      lastSurprisePct: lastSurprise ?? null,
      guidanceMove,
      reactionSpark,
      reactionPending,
      freshness,
      sourceCount,
      newSinceLastView,
      dataIncomplete,
      recentEvent,
    };
  });
}

// Index-driven variant. Reads directly from the compact events-index
// (per-ticker summary rows) instead of scanning the entire earnings
// snapshot. Semantic differences vs `buildWatchlistRows`:
//   - `reactionSpark` is always `[]` — the index doesn't carry the four
//     reaction horizons. The sparkline degrades to empty.
//   - `reactionPending` is always `false` for the same reason.
//   - `newSinceLastView` follows the same heuristic (min(sourceCount, 2)
//     when there is a lastPeriod, else 0).
//   - `nextEvent.label` for operating rows shows `nextScheduled` only —
//     the index doesn't carry the BMO/AMC/intraday timing, so we can't
//     render "<date> · BMO" here. Developer + ETF labels are identical.
export function buildWatchlistRowsFromIndex(
  entities: Entity[],
  indexEntries: EventsIndexEntry[],
  now: string,
): WatchlistRow[] {
  const byTicker = new Map(indexEntries.map((e) => [e.ticker, e]));
  return entities.map((entity) => {
    const idx = byTicker.get(entity.ticker);

    const nextScheduled = idx?.nextScheduled ?? null;
    const daysUntilNext = nextScheduled
      ? Math.round(
          (new Date(nextScheduled).getTime() - new Date(now).getTime()) /
            86400000,
        )
      : null;

    const freshness: Freshness =
      entity.securityType === "etf"
        ? computeFreshness("2026-07-23", now)
        : idx?.freshness ??
          (idx?.lastEventDate
            ? computeFreshness(idx.lastEventDate, now)
            : "never");

    const guidanceMove: GuidanceMove =
      idx?.guidanceMove ??
      (entity.securityType === "developer" ? null : "held");

    const label =
      entity.securityType === "developer"
        ? nextScheduled
          ? "catalyst · expected"
          : "unscheduled"
        : entity.securityType === "etf"
        ? "—"
        : nextScheduled
        ? formatNextEventLabel(nextScheduled, idx?.nextCadence)
        : "unscheduled";

    const dataIncomplete =
      entity.securityType === "operating" && !idx?.lastPeriod;

    const recentEvent =
      !!idx?.lastEventDate &&
      Math.abs(
        (new Date(idx.lastEventDate).getTime() - new Date(now).getTime()) /
          86400000,
      ) <= 7;

    // Prefer the entity-level count (rolling 14d news + PR count);
    // fall back to the index's per-ticker sourceCount.
    const sourceCount =
      typeof entity.sourceCount === "number"
        ? entity.sourceCount
        : idx?.sourceCount ?? 0;

    const newSinceLastView = idx?.lastPeriod ? Math.min(sourceCount, 2) : 0;

    return {
      ticker: entity.ticker,
      entity,
      nextEvent: {
        date: nextScheduled,
        daysUntil: daysUntilNext,
        label,
        cadence: idx?.nextCadence,
      },
      lastPeriod: idx?.lastPeriod ?? null,
      lastSurprisePct: idx?.lastSurprisePct ?? null,
      guidanceMove,
      reactionSpark: [],
      reactionPending: false,
      freshness,
      sourceCount,
      newSinceLastView,
      dataIncomplete,
      recentEvent,
    };
  });
}

// Legacy fixture wrapper. New code paths should call buildWatchlistRows
// with data pulled from the store.
export function buildWatchlist(): WatchlistRow[] {
  // Reuse getLatestEvent from the fixture module to keep the wrapper thin.
  void getLatestEvent;
  return buildWatchlistRows(ENTITY_REGISTRY, EARNINGS_FIXTURE, todayIso());
}
