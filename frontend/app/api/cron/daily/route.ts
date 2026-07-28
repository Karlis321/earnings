import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import { fanoutNews, fetchEntityNews } from "@/server/vendors/news";
import { fetchPressReleases } from "@/server/vendors/pressReleases";
import { matureEventReaction } from "@/server/lib/reactionMaturation";
import {
  buildEventShell,
  buildPastEvent,
  buildTimeseriesEvent,
  computeSourceLink,
  detectRestatements,
  findMatchingEvent,
  findShellForPeriod,
  mergeMetricsInto,
  parseYahooPeriod,
  periodFromReportingDate,
  promoteShellToPast,
  seedReactionPoints,
} from "@/server/lib/cronDetections";
import {
  collectPastDatesByTicker,
  estimateNextEvent,
} from "@/server/lib/estimateNextEvent";
import {
  fetchAndIngest,
  isIngestableUrl,
  type FetchAndIngestInput,
} from "@/server/lib/documentIngest";
import {
  yahooEarnings,
  yahooLookup,
  yahooQuoteMetaBatch,
  yahooTimeseries,
} from "@/server/vendors/yahoo";
import { fmpEarnings } from "@/server/vendors/fmp";
import { secSubmissionsShells } from "@/server/vendors/sec";
import {
  applySecVerbatimToEvent,
  makeSecFactsCache,
} from "@/server/lib/secVerbatim";
import { refreshSectorUniverse } from "@/server/lib/sectorExpansion";
import { resolveEdgarCik } from "@/server/lib/edgarCikResolver";
import {
  checkRegressions,
  computePipelineReport,
  emptyVendorStats,
  toHistoryEntry,
} from "@/server/lib/pipelineReport";
import { capTierFor } from "@/lib/capTier";
import { urlHash } from "@/lib/itemDedupe";
import {
  mentionsHolding,
  matchesExclusionAlias,
  tickerSearchTokens,
} from "@/lib/tickerMatch";
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
  const newEvents: CronRunSummary["newEvents"] = [];
  const restatements: CronRunSummary["restatements"] = [];
  let ok = true;

  // Per-vendor call counters for the pipeline self-check (audit-prompt Part 2).
  // Incremented at each yahoo/timeseries/sec/fmp call site; consumed by
  // computePipelineReport at end of run.
  const perVendor = emptyVendorStats();

  // Snapshot of all in-memory event mutations for this run. We apply them
  // in one commit at the end (single-commit rule).
  const pendingEvents = new Map<string, EventRecord>();
  // Newly-created event shells (Yahoo next-event detection). Committed
  // alongside pendingEvents in the same mutateEarnings call.
  const newlyCreated: EventRecord[] = [];
  // Candidate URLs for document ingestion (press-release items we pulled
  // during the sources fan-out). Deduped + capped globally after the loop.
  const ingestCandidates = new Map<string, FetchAndIngestInput>();
  // Document ingest counters, filled by the Phase B pass.
  let docsAttempted = 0;
  let docsIngested = 0;
  let docsUnchanged = 0;
  let docsFailed = 0;
  let docsRecent: CronRunSummary["documents"]["recent"] = [];
  // Market-cap refresh counters, filled by step 6.
  let mcAttempted = 0;
  let mcUpdated = 0;
  let mcUnchanged = 0;
  let mcFailed = 0;
  const mcTierChanges: NonNullable<CronRunSummary["marketCap"]>["tierChanges"] = [];
  // TTM fundamentals collected during step 3's per-entity Yahoo pass.
  // Applied to registry in step 6b alongside market-cap updates.
  const fundamentalsMap = new Map<string, import("@/lib/types").EntityFundamentals>();
  const asOfDateForCron = new Date().toISOString().slice(0, 10);
  // Pre-run snapshot — hoisted out of the try so the pipeline self-check
  // block after writeCronStatus can compute events_added_today from the
  // difference between the pre-run snap and the post-run reconciled snap.
  let snap: EarningsSnapshot = {
    schema: "earnings/v1",
    lastUpdated: startedAt.toISOString(),
    events: [],
  };

  try {
    snap = await store.readEarnings();
    const registry = await store.readRegistry();
    const now = new Date();

    // Merge-or-push router (audit finding — capability e).
    // Every place that previously did `alreadyHasEvent + push` now routes
    // through this: if an existing event matches (by ticker + period, or by
    // ticker + eventDate within 45d), enrich it via mergeMetricsInto and
    // record the merge in pendingEvents so it lands in the single commit.
    // Otherwise the event is appended to newlyCreated.
    //
    // Returns { merged: true, into: <id> } or { merged: false, id: <new id> }
    // so the caller can decide whether to push a "newEvents" summary entry.
    const routeCreatedEvent = (
      ev: EventRecord,
      entity?: (typeof registry)[number],
    ): { merged: true; into: string } | { merged: false; id: string } => {
      // Stamp sourceLink at creation time so every new/created event has
      // a click-through by the time it lands in the snapshot. Uses the
      // supplied entity when available (loop caller passes it in);
      // otherwise falls back to a registry lookup by ticker.
      const ent = entity ?? registry.find((e) => e.ticker === ev.ticker);
      if (ev.sourceLink === undefined) {
        ev.sourceLink = computeSourceLink(ev, ent);
      }
      const combined: EventRecord[] = [
        ...snap.events.map((e) => pendingEvents.get(e.id) ?? e),
        ...newlyCreated,
      ];
      const match = findMatchingEvent(
        combined,
        ev.ticker,
        ev.period,
        ev.eventDate ?? ev.scheduledDate ?? null,
      );
      if (match) {
        const merged = mergeMetricsInto(match, ev);
        // Adopt an incoming sourceLink when the target lacked one so the
        // merge doesn't strip a click-through added by a higher-quality feed.
        if (!match.sourceLink && ev.sourceLink) {
          (merged as EventRecord).sourceLink = ev.sourceLink;
        }
        pendingEvents.set(match.id, merged);
        return { merged: true, into: match.id };
      }
      newlyCreated.push(ev);
      return { merged: false, id: ev.id };
    };

    // ---- Pre-loop: fetch news + press-releases ONCE per run ----
    // Previously fanoutNews ran inside the per-event loop with
    // `query: entity.displayName` — that produced two problems:
    //   (a) O(events × 55 RSS feeds) HTTP calls per cron; and
    //   (b) the displayName substring pre-filter dropped headlines that
    //       mentioned the entity by a shorter alias (e.g. "Hudbay reports
    //       Q3" was cut because it didn't contain "Hudbay Minerals").
    // Fix: fetch the entire news pool once with no query, cache press
    // releases per unique ticker, and let mentionsHolding do the filtering.
    const newsRun = await fanoutNews({ days: 14 }).catch(() => null);
    if (newsRun) {
      let newsCount = 0;
      for (const es of newsRun.engineStatus ?? []) {
        if (es.ok) newsCount += es.itemsFound;
      }
      mergeEngine(
        engineAgg,
        "google",
        (newsRun.engineStatus ?? []).some((s) => s.ok),
        newsCount,
      );
    }
    const pressCache = new Map<
      string,
      Awaited<ReturnType<typeof fetchPressReleases>> | null
    >();
    const getPress = async (ticker: string) => {
      if (pressCache.has(ticker)) return pressCache.get(ticker)!;
      const r = await fetchPressReleases(ticker).catch(() => null);
      pressCache.set(ticker, r);
      if (r) {
        for (const es of r.engineStatus ?? []) {
          const engine = bucketPressEngine(es.label, es.kind);
          mergeEngine(engineAgg, engine, es.ok, es.itemsFound);
        }
      }
      return r;
    };

    // Per-entity Google News search — supplements the shared theme pool
    // with a targeted OR-query per ticker. Cached per unique ticker so
    // multi-event tickers don't refetch. Fail-soft (null on error).
    const entityNewsCache = new Map<
      string,
      Awaited<ReturnType<typeof fetchEntityNews>> | null
    >();
    const getEntityNews = async (entity: (typeof registry)[number]) => {
      const key = entity.ticker;
      if (entityNewsCache.has(key)) return entityNewsCache.get(key)!;
      const tokens = tickerSearchTokens(entity);
      const r = await fetchEntityNews(entity.ticker, tokens, 14).catch(
        () => null,
      );
      entityNewsCache.set(key, r);
      if (r) {
        mergeEngine(engineAgg, "google", r.ok, r.itemsFound);
      }
      return r;
    };

    // Group events by ticker up-front so matureEventReaction gets sibling
    // events (needed for contamination detection). Uses snap.events (pre-run)
    // since we're only checking whether *newer* events overlap this event's
    // horizon — additions in this run don't retroactively contaminate.
    const eventsByTicker = new Map<string, EventRecord[]>();
    for (const ev of snap.events) {
      if (!eventsByTicker.has(ev.ticker)) eventsByTicker.set(ev.ticker, []);
      eventsByTicker.get(ev.ticker)!.push(ev);
    }

    for (const original of snap.events) {
      const entity = registry.find((e) => e.ticker === original.ticker);
      if (!entity) continue;
      const errors: string[] = [];

      // Start from the possibly-mutated version for this event id.
      let current = pendingEvents.get(original.id) ?? original;

      // ---- 1. Sources fan-out (only inside the active window) ----
      let appended = 0;
      if (withinWindow(current.scheduledDate, now)) {
        const newsRes = newsRun;
        const pressRes = await getPress(entity.ticker);
        const entityNewsRes = await getEntityNews(entity);

        const seen = new Set(current.sources.items.map((i) => i.id));
        const nowIso = now.toISOString();
        const newItems: SourceItem[] = [];

        // Merge the shared theme pool with the entity-specific Google News
        // hits. Dedup by URL happens further down when items are hashed
        // into the SourceItem.id set — same URL from both sources
        // collapses to one.
        const combinedNews = [
          ...(newsRes?.items ?? []),
          ...(entityNewsRes?.items ?? []),
        ];
        for (const n of combinedNews) {
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
            hosted: isIngestableUrl(p.url),
            summary: null,
          });
          if (isIngestableUrl(p.url) && !ingestCandidates.has(p.url)) {
            ingestCandidates.set(p.url, {
              url: p.url,
              provenance: p.provenance,
              source: p.source,
              publishedAt: p.time,
            });
          }
        }

        // (per-engine aggregation happens once outside the loop now)

        appended = newItems.length;
        if (appended > 0) {
          // Build the merged engineStatus for the event (only engines that
          // actually contributed to this event's stream — subset of the
          // run-wide aggregate above).
          const perEventStatus: EngineStatus[] = [];
          if (newsRes || entityNewsRes) {
            const sharedOk = (newsRes?.engineStatus ?? []).some((s) => s.ok);
            const entityOk = entityNewsRes?.ok ?? false;
            perEventStatus.push({
              engine: "google",
              ok: sharedOk || entityOk,
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
      // Idempotent self-heal: past events built under the old code have
      // reaction.points = []. seedReactionPoints fills them in from
      // HORIZONS so matureEventReaction can then seed baseline + compute.
      current = seedReactionPoints(current);
      let matured: Horizon[] = [];
      try {
        const siblings = eventsByTicker.get(entity.ticker) ?? [];
        const m = await matureEventReaction(current, entity, siblings);
        current = m.updated;
        matured = m.matured;
        for (const err of m.errors) errors.push(`reaction: ${err}`);
      } catch (e) {
        errors.push(`reaction: ${(e as Error).message}`);
      }

      // Persist if we picked up sources, matured a horizon, or the
      // reaction step mutated the event (baseline seeded, points seeded).
      const reactionChanged =
        current.reaction !== original.reaction ||
        current.reaction.baselineDate !== original.reaction.baselineDate ||
        current.reaction.baselineClose !== original.reaction.baselineClose ||
        current.reaction.points.length !== original.reaction.points.length;
      if (appended > 0 || matured.length > 0 || reactionChanged) {
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

    // ---- 3. Per-entity Yahoo pass: next-event upsert + restatement detection ----
    // Runs once per operating entity (ETFs + developers don't have earnings).
    // Uses the possibly-mutated current event for restatement comparison.
    for (const entity of registry) {
      if (entity.securityType !== "operating") continue;
      let yahooSymbol: string | null = entity.yahooSymbol ?? null;
      if (!yahooSymbol) {
        try {
          const [sym, exch = "US"] = entity.ticker.split(/\s+/);
          const resolved = await yahooLookup(sym, exch);
          if ("error" in resolved) continue;
          yahooSymbol = resolved.yahooSymbol;
        } catch { continue; }
      }
      perVendor.yahoo_qs.attempted++;
      const yahoo = await yahooEarnings(yahooSymbol);
      if (!yahoo) {
        perVendor.yahoo_qs.errored++;
        continue;
      }
      if ((yahoo.pastQuarters?.length ?? 0) === 0) {
        perVendor.yahoo_qs.empty++;
      } else {
        perVendor.yahoo_qs.succeeded++;
      }

      // --- FMP fallback for Yahoo blanks ---
      // Foreign 40-F / 20-F filers often return empty earningsChart from
      // Yahoo (see earlier data audit: 44% coverage ceiling). If FMP_API_KEY
      // is set and Yahoo returned zero past quarters, try FMP as a
      // secondary source. Fail-soft: null result restores Yahoo-only path.
      let fmp: Awaited<ReturnType<typeof fmpEarnings>> = null;
      if (
        yahoo.pastQuarters.length === 0 &&
        process.env.FMP_API_KEY
      ) {
        perVendor.fmp.attempted++;
        fmp = await fmpEarnings(yahooSymbol).catch(() => null);
        if (!fmp) {
          perVendor.fmp.errored++;
        } else if ((fmp.pastQuarters?.length ?? 0) === 0) {
          perVendor.fmp.empty++;
        } else {
          perVendor.fmp.succeeded++;
        }
      }

      // Capture TTM fundamentals from the same response — no extra HTTP.
      // Applied to the registry alongside market-cap refresh in step 6b.
      if (yahoo.ttm) {
        fundamentalsMap.set(entity.ticker, {
          totalRevenueTTM: yahoo.ttm.totalRevenue,
          ebitdaTTM: yahoo.ttm.ebitda,
          grossMargin: yahoo.ttm.grossMargin,
          operatingMargin: yahoo.ttm.operatingMargin,
          ebitdaMargin: yahoo.ttm.ebitdaMargin,
          revenueGrowth: yahoo.ttm.revenueGrowth,
          sharesOutstanding: yahoo.ttm.sharesOutstanding,
          enterpriseValue: yahoo.ttm.enterpriseValue,
          trailingEps: yahoo.ttm.trailingEps,
          forwardEps: yahoo.ttm.forwardEps,
          profitMargin: yahoo.ttm.profitMargin,
          currency: yahoo.ttm.currency,
          asOf: asOfDateForCron,
        });
      }

      // --- 3a. Next-event upsert ---
      // Audit finding (capability e): route via merge-on-match instead of
      // alreadyHasEvent boolean skip. A same-period shell already on file
      // (e.g. estimator-median-gap) gets its metadata enriched rather
      // than shadowed by a duplicate row.
      const effectiveNextDate = yahoo.nextEarningsDate ?? fmp?.nextEarningsDate ?? null;
      if (effectiveNextDate) {
        const { label } = periodFromReportingDate(effectiveNextDate);
        const shell = buildEventShell(entity, effectiveNextDate, label);
        const routed = routeCreatedEvent(shell, entity);
        if (!routed.merged) {
          newEvents.push({
            eventId: routed.id,
            ticker: entity.ticker,
            period: label,
            scheduledDate: effectiveNextDate,
          });
        }
      }

      // --- 3a.5. Past-quarter backfill + shell promotion ---
      // Yahoo returns the last 4 completed quarters in earningsChart.quarterly.
      // For each:
      //   (a) if we already have a shell (announced future date, no eventDate,
      //       no actuals yet), PROMOTE it in place — fill EPS + revenue,
      //       set eventDate = scheduledDate (the real announced report day).
      //       Reaction baseline stays null so matureEventReaction seeds it
      //       from the real close.
      //   (b) if a past event already exists (eventDate set), leave it —
      //       restatement detection below handles Δ.
      //   (c) if nothing exists, fall back to buildPastEvent with the
      //       mid-month stand-in scheduledDate.
      const combinedEvents = [...snap.events, ...newlyCreated];
      // Merge Yahoo pastQuarters with FMP fallback quarters when Yahoo
      // was empty. FMP's shape overlaps enough that we treat it as an
      // equivalent past-quarter list for backfill.
      // Currency pass-through (audit finding — capability g): Yahoo's
      // ttm.currency and FMP's reportedCurrency describe the reporting
      // currency for the numeric actuals. Fall back to entity.currency
      // (registry value) when neither vendor returned one.
      const yahooReportingCurrency = yahoo.ttm?.currency ?? null;
      const fmpReportingCurrency: string | null = null; // FmpQuarter doesn't surface it today
      const pastQuartersToProcess: Array<{
        period: string;
        actual: number | null;
        estimate: number | null;
        surprisePct: number | null;
        revenue: number | null;
        netIncome: number | null;
        _currency: string | undefined;
      }> =
        (yahoo.pastQuarters?.length ?? 0) > 0
          ? yahoo.pastQuarters.map((q) => ({
              ...q,
              _currency: yahooReportingCurrency ?? entity.currency ?? undefined,
            }))
          : (fmp?.pastQuarters ?? []).map((q) => ({
              period: q.period,
              actual: q.eps,
              estimate: null,
              surprisePct: null,
              revenue: q.revenue,
              netIncome: q.netIncome,
              _currency: fmpReportingCurrency ?? entity.currency ?? undefined,
            }));
      for (const q of pastQuartersToProcess) {
        const parsed = parseYahooPeriod(q.period);
        if (!parsed) continue;
        const shell = findShellForPeriod(combinedEvents, entity.ticker, q.period);
        if (shell) {
          // Promote the announced-date shell into a completed past event.
          // Currency passes through — audit finding (capability g).
          const promoted = promoteShellToPast(
            shell,
            q,
            entity,
            yahooSymbol,
            q._currency,
          );
          // Refresh sourceLink now that the promoted event has an eventDate
          // + metrics baked in — promotion may change provenance/period.
          promoted.sourceLink = computeSourceLink(promoted, entity);
          pendingEvents.set(shell.id, promoted);
          newEvents.push({
            eventId: shell.id,
            ticker: entity.ticker,
            period: shell.period,
            scheduledDate: shell.scheduledDate,
          });
          continue;
        }
        // No shell — build a past event; route through the merge helper so
        // an FY-period sibling (from timeseries / SEC XBRL) gets enriched
        // rather than shadowed by a duplicate row (audit finding — capability e).
        const past = buildPastEvent(entity, q, yahooSymbol, q._currency);
        if (past) {
          const routed = routeCreatedEvent(past, entity);
          if (!routed.merged) {
            newEvents.push({
              eventId: routed.id,
              ticker: entity.ticker,
              period: past.period,
              scheduledDate: past.scheduledDate,
            });
          }
        }
      }

      // --- 3a.6. Yahoo fundamentals-timeseries enrichment ---
      // Audit finding (capability b): call the fundamentals-timeseries
      // endpoint AFTER earningsChart + FMP fallback. This is the primary
      // source of Revenue / EBIT / EBITDA / GrossProfit / NetIncome for
      // foreign wrappers whose earningsChart returns empty. Each metric
      // is stamped with `d.currencyCode` as its unit (currency per data
      // point — capability g).
      // Fail-soft: null result skips this step entirely.
      perVendor.yahoo_ts.attempted++;
      const ts = await yahooTimeseries(yahooSymbol).catch(() => null);
      if (!ts) {
        perVendor.yahoo_ts.errored++;
      } else if (ts.byQuarter.size === 0) {
        perVendor.yahoo_ts.empty++;
      } else {
        perVendor.yahoo_ts.succeeded++;
      }
      if (ts && ts.byQuarter.size > 0) {
        for (const [asOfDate, bucket] of ts.byQuarter) {
          if (bucket.size === 0) continue;
          const tsEvent = buildTimeseriesEvent(entity, yahooSymbol, asOfDate, bucket);
          const routed = routeCreatedEvent(tsEvent, entity);
          if (!routed.merged) {
            newEvents.push({
              eventId: routed.id,
              ticker: entity.ticker,
              period: tsEvent.period,
              scheduledDate: tsEvent.scheduledDate,
            });
          }
        }
      }

      // --- 3b. Restatement detection ---
      // Only compares against events with matching parsed period. Run against
      // both original + pending versions so a same-cycle append doesn't mask
      // a genuine restatement.
      for (const original of snap.events) {
        if (original.ticker !== entity.ticker) continue;
        const current = pendingEvents.get(original.id) ?? original;
        const { updated, hits } = detectRestatements(current, entity, yahoo);
        if (hits.length > 0) {
          restatements.push(...hits);
          pendingEvents.set(original.id, updated);
        }
      }
    }

    // ---- 3b.5. SEC submissions date shells ----
    // Audit finding (capability c): for entities WITH edgarCik but fewer
    // than 2 past events on file, pull EDGAR submissions/CIK{n}.json and
    // create one shell per periodic filing (10-Q / 10-K / 20-F / 40-F /
    // 6-K). These carry no metric values but give the median-gap
    // estimator a real historical rhythm to project a next-event date and
    // provide real filing URLs for click-through.
    //
    // Per memory note `project_estimator_46_nulls`, secSubmissionsShells()
    // pulls the last 12 periods so semi-annual filers get both cycles in
    // history — that's the free-coverage fix scoped for the estimator gap.
    //
    // Every incoming shell routes through routeCreatedEvent so a Yahoo
    // timeseries event on the same fiscal period (higher provenance rank
    // = 90 vs 20) enriches instead of getting shadowed.
    {
      const countPastByTicker = new Map<string, number>();
      const rolledEvents: EventRecord[] = [
        ...snap.events.map((e) => pendingEvents.get(e.id) ?? e),
        ...newlyCreated,
      ];
      for (const ev of rolledEvents) {
        if (!ev.eventDate) continue;
        countPastByTicker.set(
          ev.ticker,
          (countPastByTicker.get(ev.ticker) ?? 0) + 1,
        );
      }
      for (const entity of registry) {
        if (!entity.edgarCik) continue;
        if (entity.securityType !== "operating") continue;
        if ((countPastByTicker.get(entity.ticker) ?? 0) >= 2) continue;
        perVendor.sec.attempted++;
        let shells: Awaited<ReturnType<typeof secSubmissionsShells>> = [];
        try {
          shells = await secSubmissionsShells(entity);
          if (shells.length === 0) {
            perVendor.sec.empty++;
          } else {
            perVendor.sec.succeeded++;
          }
        } catch {
          perVendor.sec.errored++;
          shells = [];
        }
        for (const s of shells) {
          const routed = routeCreatedEvent(s, entity);
          if (!routed.merged) {
            newEvents.push({
              eventId: routed.id,
              ticker: entity.ticker,
              period: s.period,
              scheduledDate: s.scheduledDate,
            });
          }
        }
      }
    }

    // ---- 3c. Next-event estimator ----
    // For any operating entity WITHOUT a shell for a next event, project
    // one forward using the median gap between its past-event dates.
    // Self-healing: on the next cron pass, if a real Yahoo nextEarningsDate
    // shows up for the same period, the promotion pass upgrades the
    // estimated shell to a real one.
    const combinedForEstimator = [
      ...snap.events,
      ...newlyCreated,
    ];
    const pastByTicker = collectPastDatesByTicker(combinedForEstimator);
    const shellByTicker = new Set(
      combinedForEstimator
        .filter((ev) => !ev.eventDate)
        .map((ev) => ev.ticker),
    );
    // Latest reported fiscal-period label per ticker — needed so the
    // estimator can INCREMENT along the entity's own calendar rather
    // than deriving from the projected date (Sweep 1 fix).
    const latestPeriodByTicker = new Map<string, string>();
    for (const ev of combinedForEstimator) {
      if (!ev.eventDate) continue;
      const prev = latestPeriodByTicker.get(ev.ticker);
      if (!prev || (ev.eventDate ?? "") > (prev.split("|")[0] ?? "")) {
        latestPeriodByTicker.set(ev.ticker, `${ev.eventDate}|${ev.period}`);
      }
    }
    let estimated = 0;
    for (const entity of registry) {
      if (entity.securityType !== "operating") continue;
      // Skip if we already have a next-event shell (real or estimated)
      if (shellByTicker.has(entity.ticker)) continue;
      const past = pastByTicker.get(entity.ticker);
      if (!past || past.length < 2) continue;
      const latestPastPeriod =
        latestPeriodByTicker.get(entity.ticker)?.split("|")[1];
      const est = estimateNextEvent({
        ticker: entity.ticker,
        benchmark: entity.benchmark ?? "",
        pastEventDates: past,
        latestPastPeriod,
      });
      if (!est.ok || !est.scheduledDate || !est.period) continue;
      const shell = buildEventShell(entity, est.scheduledDate, est.period);
      // Marker so the UI can distinguish an estimated next-event shell
      // from a Yahoo-confirmed one. `freshness: "stale"` communicates
      // "we projected this, waiting for a real date" and the
      // client-side pill can hint that visually. `cadence` records
      // which class the estimator inferred (quarterly / semiannual /
      // annual) so the card can render "H2 results expected ~Feb" for
      // BHP LN / RIO LN / ULVR LN and similar.
      shell.freshness = "stale";
      if (est.cadence) shell.cadence = est.cadence;
      // Route through merge-on-match (audit finding — capability e).
      const routed = routeCreatedEvent(shell, entity);
      if (!routed.merged) {
        newEvents.push({
          eventId: routed.id,
          ticker: entity.ticker,
          period: est.period,
          scheduledDate: est.scheduledDate,
        });
      }
      estimated++;
    }
    if (estimated > 0) {
      // Note it for the cron-status summary; harmless if empty.
      eventSummaries.push({
        eventId: "estimator",
        ticker: "*",
        appended: 0,
        maturedHorizons: [],
        errors: [`estimated ${estimated} next-event shells via median-gap`],
      });
    }

    // ---- 3d. SEC-verbatim reconciliation ----
    // Rule (established by scripts/rederive-sec-xbrl.mjs and its
    // July-2026 residual pass): for any listing of a company where any
    // sibling has an edgarCik, financial metrics come from SEC XBRL
    // verbatim. Per-company fetch (one call per companyId across the
    // whole run, cached), actual unitKey from the response, latest-
    // filed wins, distributed to every listing. Yahoo/FMP values on
    // those events are superseded here — never stored as primary.
    //
    // Runs against events created OR mutated during this cron pass
    // only (touched-event set). Cached SecFacts response reuses across
    // all listings of a company. Fair-access: 1 req/sec.
    const touchedByCompany = new Map<string, EventRecord[]>();
    for (const ev of newlyCreated) {
      const entity = registry.find((e) => e.ticker === ev.ticker);
      if (!entity?.companyId) continue;
      if (!touchedByCompany.has(entity.companyId))
        touchedByCompany.set(entity.companyId, []);
      touchedByCompany.get(entity.companyId)!.push(ev);
    }
    for (const [, ev] of pendingEvents) {
      const entity = registry.find((e) => e.ticker === ev.ticker);
      if (!entity?.companyId) continue;
      if (!touchedByCompany.has(entity.companyId))
        touchedByCompany.set(entity.companyId, []);
      touchedByCompany.get(entity.companyId)!.push(ev);
    }
    const secCache = makeSecFactsCache();
    let secReplaced = 0;
    let secAdded = 0;
    let secCompaniesTouched = 0;
    for (const [companyId, evs] of touchedByCompany) {
      // Find any CIK on any member of this company.
      const members = registry.filter((e) => e.companyId === companyId);
      const cik =
        members.find((e) => e.isCanonical)?.edgarCik ??
        members.find((e) => e.edgarCik)?.edgarCik ??
        null;
      if (!cik) continue;
      const facts = await secCache.fetch(cik);
      if (!facts) continue;
      const paddedCik = String(cik).padStart(10, "0");
      let anyTouch = false;
      for (const ev of evs) {
        const r = applySecVerbatimToEvent(ev, facts, paddedCik);
        secReplaced += r.replaced;
        secAdded += r.added;
        if (r.touched) anyTouch = true;
      }
      if (anyTouch) secCompaniesTouched++;
    }
    if (secCompaniesTouched > 0) {
      eventSummaries.push({
        eventId: "sec-verbatim",
        ticker: "*",
        appended: 0,
        maturedHorizons: [],
        errors: [
          `SEC-verbatim reconciled ${secCompaniesTouched} companies · ${secReplaced} metrics replaced · ${secAdded} added`,
        ],
      });
    }

    // ---- 4. Single commit for all earnings.json mutations ----
    const totalMutations = pendingEvents.size + newlyCreated.length;
    if (totalMutations > 0) {
      await store.mutateEarnings(
        (s: EarningsSnapshot) => ({
          ...s,
          events: [
            ...s.events.map((e) => pendingEvents.get(e.id) ?? e),
            ...newlyCreated,
          ],
        }),
        `cron: ${totalMutations} event mutation(s) (${
          eventSummaries.reduce((a, e) => a + e.appended, 0)
        } sources, ${
          eventSummaries.reduce((a, e) => a + e.maturedHorizons.length, 0)
        } matured, ${newlyCreated.length} new, ${restatements.length} restated)`,
      );
    }

    // ---- 5. Document auto-ingestion (Phase B) ----
    // Loop press-release URLs through the ingestion pipeline. Capped +
    // concurrency-limited so a slow host doesn't blow the cron budget.
    // Each successful new ingest is a separate git commit (per-file);
    // idempotent replays are no-ops when the content hash is unchanged.
    const MAX_DOCS_PER_RUN = 8;
    const DOC_CONCURRENCY = 3;
    const candidates = Array.from(ingestCandidates.values()).slice(0, MAX_DOCS_PER_RUN);
    docsRecent = [];
    if (candidates.length > 0) {
      let i = 0;
      const worker = async () => {
        while (i < candidates.length) {
          const idx = i++;
          const c = candidates[idx];
          const r = await fetchAndIngest(
            c,
            (id) => store.readDocument(id),
            (doc) => store.writeDocument(doc),
          );
          docsAttempted++;
          if (!r.ok) docsFailed++;
          else if (r.changed) docsIngested++;
          else docsUnchanged++;
          docsRecent.push({
            id: r.id,
            url: r.url,
            ingestVersion: r.ingestVersion,
            changed: r.changed,
            kind: r.kind,
            error: r.error,
          });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DOC_CONCURRENCY, candidates.length) }, worker),
      );
    }

    // ---- 6a. Sector universe refresh ----
    // Screens Yahoo for the top N per sector and adds any new tickers to
    // the registry (add-only — an entity dropping out of a sector's
    // top-N stays put). Runs BEFORE market-cap refresh so newly-added
    // entities also get their caps refreshed in the same commit.
    const sectorResult = await refreshSectorUniverse(registry, 60);
    const registryWithNew = [...registry, ...sectorResult.newEntities];
    for (const n of sectorResult.newEntities) {
      newEvents.push({
        // Not a real event — reuse the newEvents summary for "additions"
        // reporting since it flows through the same UI panel.
        eventId: `new-entity-${n.ticker.replace(/\s+/g, "-")}`,
        ticker: n.ticker,
        period: n.securityType,
        scheduledDate:
          n.marketCapAsOf ?? new Date().toISOString().slice(0, 10),
      });
    }

    // ---- 6b. Market-cap refresh (whole registry INCLUDING new additions) ----
    // For every covered entity, resolve its Yahoo symbol, batch-fetch
    // marketCap, and commit an updated registry only if a value changed.
    // Runs after the events commit so the market-cap commit is a separate
    // small diff (easier to audit).
    const asOfDate = new Date().toISOString().slice(0, 10);
    const resolved: Array<{
      entity: (typeof registryWithNew)[number];
      yahooSymbol: string | null;
    }> = [];
    for (const entity of registryWithNew) {
      // Prefer the persisted yahooSymbol — search-based lookup is ambiguous
      // for symbols shared across listings (VLE, RIO on Paris, etc.).
      if (entity.yahooSymbol) {
        resolved.push({ entity, yahooSymbol: entity.yahooSymbol });
        continue;
      }
      const [sym, exch = "US"] = entity.ticker.split(/\s+/);
      try {
        const r = await yahooLookup(sym, exch);
        resolved.push({
          entity,
          yahooSymbol: "error" in r ? null : r.yahooSymbol,
        });
      } catch {
        resolved.push({ entity, yahooSymbol: null });
      }
    }
    const symbols = resolved
      .map((r) => r.yahooSymbol)
      .filter((s): s is string => !!s);
    const quoteBatchSize = 100;
    const bySymbol = new Map<string, { marketCapUsd: number | null }>();
    for (let i = 0; i < symbols.length; i += quoteBatchSize) {
      const batch = symbols.slice(i, i + quoteBatchSize);
      const rows = await yahooQuoteMetaBatch(batch);
      for (const row of rows) {
        // marketCapUsd is home-currency marketCap × current FX rate.
        // yahooQuoteMetaBatch applies the conversion internally.
        bySymbol.set(row.yahooSymbol, { marketCapUsd: row.marketCapUsd });
      }
    }

    // ---- 6c. Backfill missing SEC EDGAR CIKs ----
    // Entities added before the auto-resolver landed have edgarCik === undefined.
    // Resolve them here so /api/press-releases hits EDGAR automatically for
    // any SEC filer (including 20-F/40-F foreign issuers). `null` marks a
    // ticker as "checked and not on SEC" so we don't re-hit the resolver.
    const cikResolutions = new Map<string, string | null>();
    await Promise.all(
      registry
        .filter((e) => e.edgarCik === undefined)
        .map(async (e) => {
          try {
            const cik = await resolveEdgarCik({
              ticker: e.ticker,
              legalName: e.legalName,
            });
            cikResolutions.set(e.ticker, cik);
          } catch {
            /* transient — leave as undefined for next cron */
          }
        }),
    );

    const updatedEntities = registry.map((entity) => {
      mcAttempted++;
      const entry = resolved.find((r) => r.entity.ticker === entity.ticker);
      const sym = entry?.yahooSymbol;
      const cikResolved = cikResolutions.has(entity.ticker)
        ? cikResolutions.get(entity.ticker)!
        : entity.edgarCik;
      const cikChanged =
        cikResolutions.has(entity.ticker) &&
        cikResolutions.get(entity.ticker) !== entity.edgarCik;
      const fresh = fundamentalsMap.get(entity.ticker);
      const fundamentalsChanged = fresh !== undefined;
      if (!sym) {
        mcFailed++;
        if (cikChanged || fundamentalsChanged) {
          return {
            ...entity,
            ...(cikChanged ? { edgarCik: cikResolved } : {}),
            ...(fundamentalsChanged ? { fundamentals: fresh } : {}),
          };
        }
        return entity;
      }
      const q = bySymbol.get(sym);
      if (!q || q.marketCapUsd == null) {
        mcFailed++;
        if (cikChanged || fundamentalsChanged) {
          return {
            ...entity,
            ...(cikChanged ? { edgarCik: cikResolved } : {}),
            ...(fundamentalsChanged ? { fundamentals: fresh } : {}),
          };
        }
        return entity;
      }
      const newTier = capTierFor(q.marketCapUsd);
      const priorTier = entity.capTier ?? "unknown";
      const changed =
        entity.marketCapUsd !== q.marketCapUsd || priorTier !== newTier;
      if (!changed && !cikChanged && !fundamentalsChanged) {
        mcUnchanged++;
        return entity;
      }
      if (changed) {
        mcUpdated++;
        if (priorTier !== newTier) {
          mcTierChanges.push({
            ticker: entity.ticker,
            priorTier,
            newTier,
            marketCapUsd: q.marketCapUsd,
          });
        }
      }
      return {
        ...entity,
        ...(changed
          ? {
              marketCapUsd: q.marketCapUsd,
              marketCapAsOf: asOfDate,
              capTier: newTier,
            }
          : {}),
        ...(cikChanged ? { edgarCik: cikResolved } : {}),
        ...(fundamentalsChanged ? { fundamentals: fresh } : {}),
      };
    });

    if (mcUpdated > 0 || cikResolutions.size > 0 || fundamentalsMap.size > 0) {
      await store.writeRegistry(updatedEntities);
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
    newEvents,
    restatements,
    documents: {
      attempted: docsAttempted,
      ingested: docsIngested,
      unchanged: docsUnchanged,
      failed: docsFailed,
      recent: docsRecent,
    },
    marketCap: {
      attempted: mcAttempted,
      updated: mcUpdated,
      unchanged: mcUnchanged,
      failed: mcFailed,
      tierChanges: mcTierChanges,
    },
  };

  try {
    await store.writeCronStatus(status);
  } catch (e) {
    // Never let cron-status write failure mask the run result.
    console.error("cron: writeCronStatus failed", e);
  }

  // ---- 7. Pipeline self-check (audit-prompt Part 2) ----
  // Runs AFTER writeCronStatus so it adds two extra commits (report +
  // history append). That's an accepted trade-off — see file header of
  // server/lib/pipelineReport.ts. Fail-soft: any error here is logged and
  // does not affect the run response.
  try {
    const [snapAfter, indexAfter, registryAfter, prevReport] = await Promise.all([
      store.readEarnings(),
      store.readEventsIndex?.() ?? Promise.resolve({ entries: [] } as any),
      store.readRegistry(),
      store.readPipelineReport?.() ?? Promise.resolve(null),
    ]);
    void prevReport; // reserved for future drift checks
    const historyPrev = await (store.readPipelineHistory?.() ?? Promise.resolve([]));
    const shardFileCount = indexAfter.entries?.length ?? 0;
    // Rough events_added_today = size of the newlyCreated push +
    // pendingEvents whose id wasn't in the pre-run snap.
    const preIds = new Set(snap.events.map((e) => e.id));
    const eventsAddedToday =
      newlyCreated.length +
      [...pendingEvents.keys()].filter((id) => !preIds.has(id)).length;
    const raw = computePipelineReport({
      snap: snapAfter,
      index: indexAfter,
      entities: registryAfter,
      shardFileCount,
      eventsAddedToday,
      perVendor,
      cronDurationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt,
      finishedAt,
    });
    // Yesterday's history row (last entry with date < today) for the drop rule.
    const todayIso = finishedAt.toISOString().slice(0, 10);
    const prev =
      historyPrev.filter((h) => h.date < todayIso).slice(-1)[0] ?? null;
    const report = checkRegressions(raw, prev, null);
    if (store.writePipelineReport) await store.writePipelineReport(report);
    if (store.appendPipelineHistory) await store.appendPipelineHistory(toHistoryEntry(report));
  } catch (e) {
    console.error("cron: pipeline-report step failed", e);
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
