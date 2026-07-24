import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = sp.get("ticker");
  const eventId = sp.get("event");
  const snap = await store.readEarnings();
  const registry = await store.readRegistry();

  if (eventId) {
    const evt = snap.events.find((e) => e.id === eventId);
    if (!evt) {
      return NextResponse.json(
        { error: "not_found", message: `no event ${eventId}` },
        { status: 404 },
      );
    }
    return NextResponse.json(evt, {
      headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
    });
  }

  if (ticker) {
    const entity = registry.find((e) => e.ticker === ticker);
    if (!entity) {
      return NextResponse.json(
        { error: "not_found", message: `no ticker ${ticker}` },
        { status: 404 },
      );
    }

    if (entity.securityType === "etf") {
      const etf = snap.etfDetails?.[ticker];
      return NextResponse.json(
        {
          ticker,
          type: "etf" as const,
          entity,
          etf: etf ?? null,
          fetchedAt: new Date().toISOString(),
        },
        { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } },
      );
    }

    const events = snap.events
      .filter((e) => e.ticker === ticker)
      .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));

    return NextResponse.json(
      {
        ticker,
        type: entity.securityType,
        entity,
        events,
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } },
    );
  }

  return NextResponse.json(
    { error: "bad_request", message: "supply ?ticker or ?event" },
    { status: 400 },
  );
}
