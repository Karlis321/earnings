import { NextResponse } from "next/server";
import { store } from "@/server/store";
import { findEntity } from "@/server/lib/registryHelpers";

export const dynamic = "force-dynamic";

// GET /api/health/ticker-debug?ticker=AAPL%20US
// Isolates each store call the /s/[ticker] page makes so we can see
// WHICH one is failing (or returning empty).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ticker = decodeURIComponent(url.searchParams.get("ticker") ?? "AAPL US");
  const out: Record<string, unknown> = { ticker };

  try {
    const entities = await store.readRegistry();
    out.registryCount = entities.length;
    const entity = findEntity(entities, ticker);
    out.entityFound = !!entity;
    out.entitySecurityType = entity?.securityType ?? null;
  } catch (e) {
    out.registryError = (e as Error).message;
  }

  try {
    const evs = store.readEventsForTicker
      ? await store.readEventsForTicker(ticker)
      : [];
    out.eventsCount = evs.length;
    out.eventsSample = evs.slice(0, 3).map((e) => ({
      id: e.id,
      period: e.period,
      eventDate: e.eventDate,
      metricCount: e.metrics?.length ?? 0,
    }));
    // Repro the exact ticker page pipeline that immediately follows the store read.
    try {
      const sorted = evs.slice().sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));
      out.sortOk = true;
      out.sortedFirstScheduled = sorted[0]?.scheduledDate ?? null;
      out.eventScheduledTypes = sorted.slice(0, 6).map((e) => typeof e.scheduledDate);
      out.eventPeriodTypes = sorted.slice(0, 6).map((e) => typeof e.period);
      const latestPast = sorted.find((e) => e.eventDate);
      out.latestPastId = latestPast?.id ?? null;
    } catch (e) {
      out.sortError = (e as Error).message;
    }
  } catch (e) {
    out.eventsError = (e as Error).message;
  }

  try {
    const s = store.readSummariesForTicker
      ? await store.readSummariesForTicker(ticker)
      : [];
    out.summariesCount = s.length;
  } catch (e) {
    out.summariesError = (e as Error).message;
  }

  try {
    const idx = store.readEventsIndex ? await store.readEventsIndex() : null;
    out.eventsIndexEntries = idx?.entries?.length ?? 0;
  } catch (e) {
    out.eventsIndexError = (e as Error).message;
  }

  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
