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
  const snap = await store.readEarnings();
  const cron = await store.readCronStatus();
  return NextResponse.json(
    {
      ok: true,
      snapshotAt: await store.snapshotAt(),
      schema: snap.schema,
      events: snap.events.length,
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
      staleThresholdHours: 26,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
