import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import { fanoutNews } from "@/server/vendors/news";
import { fetchPressReleases } from "@/server/vendors/pressReleases";
import type { SourceItem, EngineStatus } from "@/lib/types";

// POST /api/cron/daily — orchestration loop.
// Auth: Authorization: Bearer $CRON_SECRET (Vercel Cron sets this
// automatically from vercel.json). Rejects everything else with 401.
//
// Personal-use scope for now:
//   1. For every event with an active source window (T-2 to T+35),
//      fetch news + press-releases scoped to the ticker's aliases,
//      dedup + append to the event's sources.
//   2. Commit one aggregated update.
// Skipped for now: price refresh (client fetches Yahoo on demand),
// reaction horizon maturation (needs price cache), LLM enrichment.

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Hobby-tier max

const WINDOW_LEAD_DAYS = 2;
const WINDOW_TRAIL_DAYS = 35;

function withinWindow(scheduled: string, now: Date): boolean {
  const start = new Date(scheduled);
  start.setDate(start.getDate() - WINDOW_LEAD_DAYS);
  const end = new Date(scheduled);
  end.setDate(end.getDate() + WINDOW_TRAIL_DAYS);
  return now >= start && now <= end;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json(
      { error: "unauthorized", message: "CRON_SECRET required" },
      { status: 401 },
    );
  }
  if (store.mode() === "in-memory") {
    return NextResponse.json(
      {
        error: "persistence-unavailable",
        message:
          "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME so the cron can commit results.",
      },
      { status: 503 },
    );
  }

  const startedAt = new Date();
  const summary: {
    startedAt: string;
    finishedAt?: string;
    events: Array<{
      eventId: string;
      ticker: string;
      appended: number;
      errors: string[];
    }>;
  } = { startedAt: startedAt.toISOString(), events: [] };

  try {
    const snap = await store.readEarnings();
    const registry = await store.readRegistry();
    const now = new Date();

    for (const event of snap.events) {
      if (!withinWindow(event.scheduledDate, now)) continue;

      const entity = registry.find((e) => e.ticker === event.ticker);
      if (!entity) continue;
      const errors: string[] = [];

      const [newsRes, pressRes] = await Promise.all([
        fanoutNews({ query: entity.displayName, days: 7 }).catch((e) => {
          errors.push(`news: ${(e as Error).message}`);
          return null;
        }),
        fetchPressReleases(entity.ticker).catch((e) => {
          errors.push(`press: ${(e as Error).message}`);
          return null;
        }),
      ]);

      const seenUrls = new Set(event.sources.items.map((i) => i.url));
      const newItems: SourceItem[] = [];

      for (const n of newsRes?.items ?? []) {
        if (seenUrls.has(n.url)) continue;
        seenUrls.add(n.url);
        newItems.push({
          id: `cron-n-${event.id}-${newItems.length}`,
          url: n.url,
          headline: n.headline,
          source: n.source,
          provenance: n.category === "wire" ? "wire" : "news",
          time: n.time ?? now.toISOString(),
          articleType: "news",
          engine: "google",
          language: "en",
          hosted: false,
          summary: null,
        });
      }
      for (const p of pressRes?.items ?? []) {
        if (seenUrls.has(p.url)) continue;
        seenUrls.add(p.url);
        newItems.push({
          id: `cron-p-${event.id}-${newItems.length}`,
          url: p.url,
          headline: p.headline,
          source: p.source,
          provenance: p.provenance,
          time: p.time ?? now.toISOString(),
          articleType: "news",
          engine: p.kind === "edgar" ? "edgar" : "ir-rss",
          language: "en",
          hosted: false,
          summary: null,
        });
      }

      const engineStatus: EngineStatus[] = [];
      for (const es of newsRes?.engineStatus ?? []) {
        engineStatus.push({
          engine: "google",
          ok: es.ok,
          itemsFound: es.itemsFound,
        });
      }
      for (const es of pressRes?.engineStatus ?? []) {
        engineStatus.push({
          engine: es.kind === "edgar" ? "edgar" : "ir-rss",
          ok: es.ok,
          itemsFound: es.itemsFound,
        });
      }

      if (newItems.length > 0) {
        try {
          await store.appendEventSources(event.id, newItems, engineStatus);
        } catch (e) {
          errors.push(`persist: ${(e as Error).message}`);
        }
      }

      summary.events.push({
        eventId: event.id,
        ticker: event.ticker,
        appended: newItems.length,
        errors,
      });
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: "cron_failed",
        message: (e as Error).message,
        summary: { ...summary, finishedAt: new Date().toISOString() },
      },
      { status: 500 },
    );
  }

  summary.finishedAt = new Date().toISOString();
  return NextResponse.json({ ok: true, summary });
}

// Convenience GET — same behavior, so cron providers that only send GETs
// still work. Auth requirement is identical.
export async function GET(req: NextRequest) {
  return POST(req);
}
