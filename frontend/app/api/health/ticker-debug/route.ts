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
      // Mimic SecurityHeader's releaseUrl computation
      try {
        const latest = latestPast ?? sorted[0];
        const releaseUrl = latest?.metrics
          .find((m: any) => m.actual?.source?.url)
          ?.actual?.source?.url;
        out.releaseUrlOk = true;
        out.releaseUrlSample = releaseUrl?.slice(0, 60) ?? null;
      } catch (e) {
        out.releaseUrlError = (e as Error).message;
      }
      // Mimic OperatingDetail's initial split
      try {
        const upcoming = sorted.find((e) => !e.eventDate);
        const pastEvents = sorted.filter((e) => e.eventDate);
        const latestPastFilt = pastEvents[0];
        out.opDetailOk = true;
        out.opDetail = {
          upcoming: !!upcoming,
          pastCount: pastEvents.length,
          latestPastPeriod: latestPastFilt?.period ?? null,
        };
      } catch (e) {
        out.opDetailError = (e as Error).message;
      }
      // Mimic MetricRow rendering — iterate metrics and see if any throws
      try {
        const latest = latestPast ?? sorted[0];
        let iter = 0;
        for (const m of (latest?.metrics ?? [])) {
          iter++;
          void m.key;
          void m.displayLabel;
          void m.actual?.value;
          void m.actual?.unit;
          void m.actual?.source?.url;
          void m.estimate?.value;
          void m.surprisePct;
        }
        out.metricsIterated = iter;
      } catch (e) {
        out.metricsError = (e as Error).message;
      }
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
