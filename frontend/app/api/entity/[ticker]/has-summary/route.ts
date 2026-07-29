// Cheap poll target for the SummarizeButton. Returns
//   { hasSummaryForLatest: boolean, latestPeriod: string | null }
// so the client can stop polling and refresh when the summary lands.

import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ ticker: string }>;
}

export async function GET(_req: Request, { params }: Ctx) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const entities = await store.readRegistry();
  const entity = entities.find((e) => e.ticker === ticker);
  if (!entity) {
    return NextResponse.json(
      { hasSummaryForLatest: false, latestPeriod: null, error: "unknown-ticker" },
      { status: 404 },
    );
  }
  let canonical = entity;
  if (entity.isCanonical === false && entity.companyId) {
    const canon = entities.find(
      (e) => e.companyId === entity.companyId && e.isCanonical !== false,
    );
    if (canon) canonical = canon;
  }
  const events = store.readEventsForTicker
    ? await store.readEventsForTicker(canonical.ticker)
    : [];
  const past = events
    .filter((e) => e.eventDate)
    .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  const latestPeriod = past[0]?.period ?? null;
  if (!latestPeriod) {
    return NextResponse.json({ hasSummaryForLatest: false, latestPeriod: null });
  }
  const summaries = store.readSummariesForTicker
    ? await store.readSummariesForTicker(canonical.ticker)
    : [];
  return NextResponse.json({
    hasSummaryForLatest: summaries.some((s) => s.period === latestPeriod),
    latestPeriod,
  });
}
