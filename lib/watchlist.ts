import type { Freshness, GuidanceMove, WatchlistRow } from "@/lib/types";
import { ENTITY_REGISTRY } from "./fixtures/registry";
import { EARNINGS_FIXTURE, getLatestEvent } from "./fixtures/earnings";
import { computeFreshness, TODAY_ISO } from "./freshness";

// Build the overview rows off the entity registry + earnings snapshot.
// This is the shape /api/earnings + /api/shared-state will produce live.
export function buildWatchlist(): WatchlistRow[] {
  const now = TODAY_ISO;
  return ENTITY_REGISTRY.map((entity) => {
    const latest = getLatestEvent(entity.ticker);
    const nextUpcoming = EARNINGS_FIXTURE.events
      .filter((e) => e.ticker === entity.ticker && e.scheduledDate >= now)
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
