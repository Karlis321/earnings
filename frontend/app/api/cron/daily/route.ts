import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import { fanoutNews } from "@/server/vendors/news";
import { fetchPressReleases } from "@/server/vendors/pressReleases";
import { matureEventReaction } from "@/server/lib/reactionMaturation";
import { urlHash } from "@/lib/itemDedupe";
import { mentionsHolding, matchesExclusionAlias } from "@/lib/tickerMatch";
import type {
  CronRunSummary,
  EarningsSnapshot,
  EngineStatus,
  EventRecord,
  Horizon,
  SourceItem,
} from "@/lib/types";

// POST /api/cron/daily — orchestration loop.
// Auth: Authorization: Bearer $CRON_SECRET (Vercel Cron sets this
// automatically from vercel.json). Rejects everything else with 401.
//
// Per-run (single-commit rule per W6 plan §5):
//   1. Fan out news + press-releases per event with an open source window
//   2. Mature any ReactionPoint whose populatesOn ≤ today
//   3. Collapse every earnings.json mutation into one commit via
//      store.mutateEarnings; write cron-status.json as a second commit
//      (idempotent — same finishedAt → same content → same SHA)
//
// Idempotent on replay: news/PR items dedup by SourceItem.id (stable
// url-hash); reactions only re-mature points that are still null.

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

// Roll up per-source vendor statuses into per-engine chips the UI understands.
function bucketNewsEngine(): "google" { return "google"; }
function bucketPressEngine(label: string, kind: "edgar" | "rss"): EngineStatus["engine"] {
  if (kind === "edgar") return "edgar";
  if (/Newsfile/i.test(label)) return "newsfile";
  return "ir-rss";
}

function mergeEngine(
  agg: Map<string, EngineStatus>,
  engine: EngineStatus["engine"],
  ok: boolean,
  itemsFound: number,
) {
  const key = engine;
  const prev = agg.get(key);
  if (!prev) {
    agg.set(key, { engine, ok, itemsFound });
    return;
  }
  agg.set(key, {
    engine,
    ok: prev.ok || ok, // any-successful wins
    itemsFound: (prev.itemsFound ?? 0) + itemsFound,
  });
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
  const engineAgg = new Map<string, EngineStatus>();
  const eventSummaries: CronRunSummary["events"] = [];
  let ok = true;

  // Snapshot of all in-memory event mutations for this run. We apply them
  // in one commit at the end (single-commit rule).
  const pendingEvents = new Map<string, EventRecord>();

  try {
    const snap = await store.readEarnings();
    const registry = await store.readRegistry();
    const now = new Date();

    for (const original of snap.events) {
      const entity = registry.find((e) => e.ticker === original.ticker);
      if (!entity) continue;
      const errors: string[] = [];

      // Start from the possibly-mutated version for this event id.
      let current = pendingEvents.get(original.id) ?? original;

      // ---- 1. Sources fan-out (only inside the active window) ----
      let appended = 0;
      if (withinWindow(current.scheduledDate, now)) {
        const [newsRes, pressRes] = await Promise.all([
          fanoutNews({ query: entity.displayName, days: 14 }).catch((e) => {
            errors.push(`news: ${(e as Error).message}`);
            return null;
          }),
          fetchPressReleases(entity.ticker).catch((e) => {
            errors.push(`press: ${(e as Error).message}`);
            return null;
          }),
        ]);

        const seen = new Set(current.sources.items.map((i) => i.id));
        const nowIso = now.toISOString();
        const newItems: SourceItem[] = [];

        for (const n of newsRes?.items ?? []) {
          if (matchesExclusionAlias(n.headline, entity)) continue;
          if (!mentionsHolding(n.headline, entity)) continue;
          const id = urlHash(n.url);
          if (seen.has(id)) continue;
          seen.add(id);
          newItems.push({
            id,
            url: n.url,
            headline: n.headline,
            source: n.source,
            provenance: n.category === "wire" ? "wire" : "news",
            time: n.time ?? nowIso,
            articleType: "news",
            engine: bucketNewsEngine(),
            language: "en",
            hosted: false,
            summary: null,
          });
        }
        for (const p of pressRes?.items ?? []) {
          const id = urlHash(p.url);
          if (seen.has(id)) continue;
          seen.add(id);
          newItems.push({
            id,
            url: p.url,
            headline: p.headline,
            source: p.source,
            provenance: p.provenance,
            time: p.time ?? nowIso,
            articleType: "news",
            engine: bucketPressEngine(p.source, p.kind),
            language: "en",
            hosted: false,
            summary: null,
          });
        }

        // Aggregate per-engine status across the run.
        let newsCount = 0;
        for (const es of newsRes?.engineStatus ?? []) {
          if (es.ok) newsCount += es.itemsFound;
        }
        mergeEngine(engineAgg, "google", (newsRes?.engineStatus ?? []).some((s) => s.ok), newsCount);
        for (const es of pressRes?.engineStatus ?? []) {
          const engine = bucketPressEngine(es.label, es.kind);
          mergeEngine(engineAgg, engine, es.ok, es.itemsFound);
        }

        appended = newItems.length;
        if (appended > 0) {
          // Build the merged engineStatus for the event (only engines that
          // actually contributed to this event's stream — subset of the
          // run-wide aggregate above).
          const perEventStatus: EngineStatus[] = [];
          if (newsRes) {
            perEventStatus.push({
              engine: "google",
              ok: (newsRes.engineStatus ?? []).some((s) => s.ok),
              itemsFound: newItems.filter((i) => i.engine === "google").length,
            });
          }
          if (pressRes) {
            const engines = new Set(
              (pressRes.engineStatus ?? []).map((es) =>
                bucketPressEngine(es.label, es.kind),
              ),
            );
            for (const e of engines) {
              perEventStatus.push({
                engine: e,
                ok: (pressRes.engineStatus ?? []).some(
                  (es) => bucketPressEngine(es.label, es.kind) === e && es.ok,
                ),
                itemsFound: newItems.filter((i) => i.engine === e).length,
              });
            }
          }
          current = {
            ...current,
            sources: {
              ...current.sources,
              items: [...current.sources.items, ...newItems],
              engineStatus: perEventStatus.length ? perEventStatus : current.sources.engineStatus,
              capturedAt: nowIso,
            },
          };
        }
      }

      // ---- 2. Reaction horizon maturation ----
      let matured: Horizon[] = [];
      try {
        const m = await matureEventReaction(current, entity);
        current = m.updated;
        matured = m.matured;
        for (const err of m.errors) errors.push(`reaction: ${err}`);
      } catch (e) {
        errors.push(`reaction: ${(e as Error).message}`);
      }

      if (appended > 0 || matured.length > 0) {
        pendingEvents.set(original.id, current);
      }

      eventSummaries.push({
        eventId: original.id,
        ticker: original.ticker,
        appended,
        maturedHorizons: matured,
        errors,
      });
    }

    // ---- 3. Single commit for all earnings.json mutations ----
    if (pendingEvents.size > 0) {
      await store.mutateEarnings(
        (s: EarningsSnapshot) => ({
          ...s,
          events: s.events.map((e) => pendingEvents.get(e.id) ?? e),
        }),
        `cron: ${pendingEvents.size} event(s) updated (${
          eventSummaries.reduce((a, e) => a + e.appended, 0)
        } sources, ${
          eventSummaries.reduce((a, e) => a + e.maturedHorizons.length, 0)
        } matured)`,
      );
    }
  } catch (e) {
    ok = false;
    eventSummaries.push({
      eventId: "run",
      ticker: "*",
      appended: 0,
      maturedHorizons: [],
      errors: [`fatal: ${(e as Error).message}`],
    });
  }

  const finishedAt = new Date();
  const status: CronRunSummary = {
    schema: "cron-status/v1",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok,
    engines: Array.from(engineAgg.values()),
    events: eventSummaries,
    totalAppended: eventSummaries.reduce((a, e) => a + e.appended, 0),
    totalMatured: eventSummaries.reduce((a, e) => a + e.maturedHorizons.length, 0),
  };

  try {
    await store.writeCronStatus(status);
  } catch (e) {
    // Never let cron-status write failure mask the run result.
    console.error("cron: writeCronStatus failed", e);
  }

  return NextResponse.json(
    { ok, summary: status },
    { status: ok ? 200 : 500, headers: { "Cache-Control": "no-store" } },
  );
}

// Convenience GET — same behavior, so cron providers that only send GETs
// still work. Auth requirement is identical.
export async function GET(req: NextRequest) {
  return POST(req);
}
