import { NextResponse } from "next/server";
import { store } from "@/server/store";

// GET /api/market-pulse
//
// Serves the pre-computed Market Pulse snapshot (4 indices × 3 ranges)
// from data/market-pulse.json — refreshed daily by
// scripts/refresh-market-pulse.mjs as a phase in the refresh-universe
// orchestrator. Overview page reads this so the chart paints instantly
// on load from committed data, no per-visitor Yahoo call.
//
// Falls back to a 404 if the snapshot doesn't exist yet (first run
// before daily has fired). Client can then hit /api/prices for live
// fetch per index.

export const dynamic = "force-dynamic";
export const revalidate = 60;

export async function GET() {
  try {
    const snap = await store.readMarketPulse?.();
    if (!snap) {
      return NextResponse.json(
        { error: "not_ready", message: "market-pulse snapshot not committed yet" },
        { status: 404 },
      );
    }
    return NextResponse.json(snap, {
      headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "internal", message: (e as Error).message },
      { status: 500 },
    );
  }
}
