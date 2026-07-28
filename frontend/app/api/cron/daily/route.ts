import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import { fanoutNews, fetchEntityNews } from "@/server/vendors/news";
import { fetchPressReleases } from "@/server/vendors/pressReleases";
import { matureEventReaction } from "@/server/lib/reactionMaturation";
import {
  alreadyHasEvent,
  buildEventShell,
  buildPastEvent,
  detectRestatements,
  findShellForPeriod,
  parseStoredPeriod,
  parseYahooPeriod,
  periodFromReportingDate,
  promoteShellToPast,
  seedReactionPoints,
} from "@/server/lib/cronDetections";
import {
  fetchAndIngest,
  isIngestableUrl,
  type FetchAndIngestInput,
} from "@/server/lib/documentIngest";
import {
  yahooEarnings,
  yahooLookup,
  yahooQuoteMetaBatch,
} from "@/server/vendors/yahoo";
import { refreshSectorUniverse } from "@/server/lib/sectorExpansion";
import { resolveEdgarCik } from "@/server/lib/edgarCikResolver";
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

  try {
    const snap = await store.readEarnings();
    const registry = await store.readRegistry();
    const now = new Date();

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
        const m = await matureEventReaction(current, entity);
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
      const yahoo = await yahooEarnings(yahooSymbol);
      if (!yahoo) continue;

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
      if (yahoo.nextEarningsDate) {
        const { label } = periodFromReportingDate(yahoo.nextEarningsDate);
        const combined = [
          ...snap.events,
          ...newlyCreated,
        ];
        if (!alreadyHasEvent(combined, entity.ticker, yahoo.nextEarningsDate, label)) {
          const shell = buildEventShell(entity, yahoo.nextEarningsDate, label);
          newlyCreated.push(shell);
          newEvents.push({
            eventId: shell.id,
            ticker: entity.ticker,
            period: label,
            scheduledDate: yahoo.nextEarningsDate,
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
      for (const q of yahoo.pastQuarters ?? []) {
        const parsed = parseYahooPeriod(q.period);
        if (!parsed) continue;
        const shell = findShellForPeriod(combinedEvents, entity.ticker, q.period);
        if (shell) {
          // Promote the announced-date shell into a completed past event.
          const promoted = promoteShellToPast(shell, q, entity, yahooSymbol);
          pendingEvents.set(shell.id, promoted);
          newEvents.push({
            eventId: shell.id,
            ticker: entity.ticker,
            period: shell.period,
            scheduledDate: shell.scheduledDate,
          });
          continue;
        }
        // Already-past covered by same period label?
        const covered = combinedEvents.some((e) => {
          if (e.ticker !== entity.ticker) return false;
          if (!e.eventDate) return false;
          const p = parseStoredPeriod(e.period);
          return p && p.year === parsed.year && p.quarter === parsed.quarter;
        });
        if (covered) continue;
        // No shell + no past — create with stand-in date.
        const past = buildPastEvent(entity, q, yahooSymbol);
        if (past) {
          newlyCreated.push(past);
          newEvents.push({
            eventId: past.id,
            ticker: entity.ticker,
            period: past.period,
            scheduledDate: past.scheduledDate,
          });
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
