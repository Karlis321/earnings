import type {
  EarningsSnapshot,
  Entity,
  EventRecord,
  Freshness,
  GuidanceMove,
  WatchlistRow,
} from "@/lib/types";
import { ENTITY_REGISTRY } from "./fixtures/registry";
import { EARNINGS_FIXTURE, getLatestEvent } from "./fixtures/earnings";
import { computeFreshness, todayIso } from "./freshness";

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
        ? nextUpcoming.timing
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

    const sourceCount = latest?.sources.items.length ?? 0;
    const newSinceLastView = latest ? Math.min(sourceCount, 2) : 0;

    return {
      ticker: entity.ticker,
      entity,
      nextEvent: {
        date: nextUpcoming?.scheduledDate ?? null,
        daysUntil,
        label,
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

// Legacy fixture wrapper. New code paths should call buildWatchlistRows
// with data pulled from the store.
export function buildWatchlist(): WatchlistRow[] {
  // Reuse getLatestEvent from the fixture module to keep the wrapper thin.
  void getLatestEvent;
  return buildWatchlistRows(ENTITY_REGISTRY, EARNINGS_FIXTURE, todayIso());
}
