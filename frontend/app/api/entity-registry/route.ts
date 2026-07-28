import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import {
  yahooEarnings,
  yahooLookup,
  yahooQuoteMeta,
} from "@/server/vendors/yahoo";
import {
  buildEventShell,
  buildPastEvent,
  parseYahooPeriod,
  parseStoredPeriod,
  periodFromReportingDate,
} from "@/server/lib/cronDetections";
import { capTierFor } from "@/lib/capTier";
import { resolveEdgarCik } from "@/server/lib/edgarCikResolver";
import { isAuthorizedWrite, unauthorizedWriteResponse } from "@/server/lib/writeAuth";
import type { EarningsSnapshot, Entity } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const entities = await store.readRegistry();
  return NextResponse.json(
    { schema: "entity-registry/v1", entities },
    { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } },
  );
}

// POST /api/entity-registry — create a new entity + auto-backfill from Yahoo.
//
// After the registry write, we resolve the Yahoo symbol, fetch a market-cap
// snapshot, and insert past-4Q + upcoming event shells into earnings.json
// so the new ticker lands with a working history + graph immediately.
// Best-effort — a Yahoo failure doesn't roll the registry write back.
export async function POST(req: NextRequest) {
  if (!isAuthorizedWrite(req)) return unauthorizedWriteResponse();
  try {
    const body = (await req.json()) as Partial<Entity>;
    if (!body.ticker || !body.displayName || !body.securityType) {
      return NextResponse.json(
        { error: "bad_request", message: "ticker, displayName, securityType required" },
        { status: 400 },
      );
    }
    if (store.mode() === "in-memory") {
      return NextResponse.json(
        {
          error: "persistence-unavailable",
          message: "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME in Vercel env.",
        },
        { status: 503 },
      );
    }
    const existing = await store.readRegistry();
    if (existing.some((e) => e.ticker === body.ticker)) {
      return NextResponse.json(
        { error: "conflict", message: `${body.ticker} already exists` },
        { status: 409 },
      );
    }

    // --- Resolve Yahoo symbol so future cron runs skip the ambiguous
    //     search-based lookup. Best-effort — we still create the entity
    //     even if resolution fails.
    let yahooSymbol: string | undefined = body.yahooSymbol;
    let marketCapUsd: number | null | undefined = body.marketCapUsd;
    let marketCapAsOf: string | null | undefined = body.marketCapAsOf;
    if (!yahooSymbol) {
      try {
        const [sym, exch = "US"] = body.ticker.split(/\s+/);
        const r = await yahooLookup(sym, exch);
        if (!("error" in r)) yahooSymbol = r.yahooSymbol;
      } catch { /* ignore */ }
    }
    if (yahooSymbol && marketCapUsd == null) {
      try {
        const q = await yahooQuoteMeta(yahooSymbol);
        if (q?.marketCapUsd != null) {
          marketCapUsd = q.marketCapUsd;
          marketCapAsOf = new Date().toISOString().slice(0, 10);
        }
      } catch { /* ignore */ }
    }

    // Resolve SEC EDGAR CIK once at add time (foreign private issuers file
    // 20-F/40-F, so this hits non-US tickers too). `null` = confirmed not
    // an SEC filer; skipped only on transient errors.
    let edgarCik: string | null | undefined = body.edgarCik;
    if (edgarCik === undefined) {
      try {
        edgarCik = await resolveEdgarCik({
          ticker: body.ticker,
          legalName: body.legalName ?? body.displayName,
        });
      } catch { /* transient — leave undefined so cron retries */ }
    }

    const entity: Entity = {
      ticker: body.ticker,
      legalName: body.legalName ?? body.displayName,
      displayName: body.displayName,
      aliases: body.aliases ?? [],
      exclusionAliases: body.exclusionAliases ?? [],
      sectorTags: body.sectorTags ?? [],
      cashtag: body.cashtag ?? null,
      isCore: body.isCore ?? true,
      securityType: body.securityType,
      coverage: body.coverage ?? "deep",
      listing: body.listing ?? "",
      currency: body.currency ?? "USD",
      benchmark: body.benchmark ?? "",
      headlineMetrics: body.headlineMetrics ?? [],
      catalystTypes: body.catalystTypes ?? [],
      xHandle: body.xHandle ?? null,
      officialSources: body.officialSources ?? [],
      marketCapUsd: marketCapUsd ?? null,
      marketCapAsOf: marketCapAsOf ?? null,
      capTier: capTierFor(marketCapUsd ?? null),
      yahooSymbol,
      edgarCik,
      // fundamentals populated below after yahooEarnings call
    };
    await store.writeRegistry([...existing, entity]);

    // --- Auto-backfill earnings (past 4Q + upcoming) for operating types.
    // Skipped for developers (no earnings) and ETFs (Yahoo returns nothing
    // meaningful here). Best-effort — if Yahoo returns nothing, the entity
    // still lands cleanly, just without seeded events.
    let pastAdded = 0;
    let upcomingAdded = 0;
    let fundamentalsPopulated = false;
    if (entity.securityType === "operating" && yahooSymbol) {
      try {
        const yahoo = await yahooEarnings(yahooSymbol);
        if (yahoo) {
          // Populate entity fundamentals from the TTM chunk of the same
          // response — no extra HTTP call.
          if (yahoo.ttm) {
            const asOf = new Date().toISOString().slice(0, 10);
            entity.fundamentals = {
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
              asOf,
            };
            fundamentalsPopulated = true;
            // Write registry again with fundamentals attached — this is a
            // second commit but small, and only fires when we actually
            // got useful data back.
            await store.writeRegistry(
              [...existing, entity],
            );
          }
          await store.mutateEarnings(
            (s: EarningsSnapshot) => {
              const events = s.events.slice();
              // Past quarters.
              for (const q of yahoo.pastQuarters) {
                const parsed = parseYahooPeriod(q.period);
                if (!parsed) continue;
                const already = events.some((e) => {
                  if (e.ticker !== entity.ticker) return false;
                  const p = parseStoredPeriod(e.period);
                  return (
                    p && p.year === parsed.year && p.quarter === parsed.quarter
                  );
                });
                if (already) continue;
                const past = buildPastEvent(entity, q, yahooSymbol);
                if (past) {
                  events.push(past);
                  pastAdded++;
                }
              }
              // Upcoming.
              if (yahoo.nextEarningsDate) {
                const { label } = periodFromReportingDate(yahoo.nextEarningsDate);
                const already = events.some(
                  (e) =>
                    e.ticker === entity.ticker &&
                    e.scheduledDate === yahoo.nextEarningsDate,
                );
                if (!already) {
                  events.push(
                    buildEventShell(entity, yahoo.nextEarningsDate, label),
                  );
                  upcomingAdded++;
                }
              }
              return { ...s, events };
            },
            `entity: ${entity.ticker} + ${pastAdded} past ${upcomingAdded} upcoming`,
          );
        }
      } catch { /* best-effort; the entity write already succeeded */ }
    }

    return NextResponse.json({
      ok: true,
      ticker: entity.ticker,
      yahooSymbol: yahooSymbol ?? null,
      marketCapUsd: entity.marketCapUsd,
      capTier: entity.capTier,
      edgarCik: entity.edgarCik ?? null,
      pastAdded,
      upcomingAdded,
      fundamentalsPopulated,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}
