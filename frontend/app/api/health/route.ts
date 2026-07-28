import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

// GET /api/health
// Extended in W6 to include:
//   - engines: EngineStatus[] from the last cron run
//   - lastCronRun: ISO stamp; null if no cron has run yet
//   - staleThresholdHours: banner trigger threshold (26h weekday default)
//   - totals: appended + matured from the last run
export async function GET() {
  // Event count comes from the compact events-index — no need to pull
  // the 40+ MB earnings monolith just to count rows.
  const index = store.readEventsIndex
    ? await store.readEventsIndex()
    : { entries: [] as Array<{ count: number }> };
  const eventCount = index.entries.reduce((n, e) => n + (e.count ?? 0), 0);
  const cron = await store.readCronStatus();
  return NextResponse.json(
    {
      ok: true,
      snapshotAt: await store.snapshotAt(),
      schema: "earnings/v1",
      events: eventCount,
      mode: store.mode(),
      ghPatPresent: store.ghPatPresent(),
      lastCronRun: cron?.finishedAt ?? null,
      lastCronOk: cron?.ok ?? null,
      cronDurationMs: cron?.durationMs ?? null,
      engines: cron?.engines ?? [],
      totalAppended: cron?.totalAppended ?? 0,
      totalMatured: cron?.totalMatured ?? 0,
      cronEventSummaries: cron?.events ?? [],
      newEvents: cron?.newEvents ?? [],
      restatements: cron?.restatements ?? [],
      documents: cron?.documents ?? {
        attempted: 0,
        ingested: 0,
        unchanged: 0,
        failed: 0,
        recent: [],
      },
      marketCap: cron?.marketCap ?? {
        attempted: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
        tierChanges: [],
      },
      staleThresholdHours: 26,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
