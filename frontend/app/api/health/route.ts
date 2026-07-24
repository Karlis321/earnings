import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const snap = await store.readEarnings();
  return NextResponse.json(
    {
      ok: true,
      snapshotAt: await store.snapshotAt(),
      schema: snap.schema,
      events: snap.events.length,
      mode: store.mode(),
      ghPatPresent: store.ghPatPresent(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
