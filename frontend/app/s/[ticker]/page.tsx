import { notFound } from "next/navigation";
import { store } from "@/server/store";
import { findEntity } from "@/server/lib/registryHelpers";
import {
  normalizeEvents,
  normalizeEntity,
  normalizeSummaries,
} from "@/lib/normalize";
import { SecurityHeader } from "@/components/security/SecurityHeader";
import { OperatingDetail } from "@/components/security/OperatingDetail";
import { DeveloperDetail } from "@/components/security/DeveloperDetail";
import { EtfDetail } from "@/components/security/EtfDetail";
import { SummaryPanel } from "@/components/security/SummaryPanel";
import { SummarizeButton } from "@/components/security/SummarizeButton";
import { ExtendedMetricsPanel } from "@/components/security/ExtendedMetricsPanel";
import { TickerSignals } from "@/components/security/TickerSignals";
import { SectorChips } from "@/components/security/SectorChips";
import { FocusToggle } from "@/components/security/FocusToggle";
import { ReturnChip } from "@/components/shell/ReturnChip";
import { GuidanceTimeline, Panel } from "@/components/primitives";
import { EmptyState } from "@/components/primitives";
import { MarkSeen } from "@/components/shell/MarkSeen";
import { computeFreshness, todayIso } from "@/lib/freshness";
import type { EventRecord } from "@/lib/types";

// Summarize button gate widened per Task 2 (prompt1): the on-demand
// /earnings path is now available to any ticker with shard metrics.
// covered.json's remaining role is the nightly /sweep scope, which
// stays as-is — not consulted here. The command itself auto-downgrades
// to KPI-only when the primary filing can't be reached honestly.

// Security Detail — three variants per FE PRD §7.3–7.5.

interface Props {
  params: Promise<{ ticker: string }>;
}

export const dynamic = "force-dynamic";

export default async function SecurityDetailPage({ params }: Props) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const [entities, blueOcean, ruleBreaker, qarv, sectorSignals, sharedState] =
    await Promise.all([
      store.readRegistry(),
      store.readScreen ? store.readScreen("blue-ocean") : Promise.resolve(null),
      store.readScreen ? store.readScreen("rule-breaker") : Promise.resolve(null),
      store.readScreen ? store.readScreen("qarv") : Promise.resolve(null),
      store.readSectorSignals
        ? store.readSectorSignals()
        : Promise.resolve(null),
      store.readSharedState(),
    ]);
  const initialInFocus =
    (sharedState.preferences?.focusTickers ?? []).includes(ticker);
  const rawEntity = findEntity(entities, ticker);
  if (!rawEntity) notFound();
  const entity = normalizeEntity(rawEntity)!;

  // Framework-screen coverage for this specific ticker.
  const blueOceanCard =
    blueOcean?.screens.find((s) => s.ticker === ticker) ?? null;
  const ruleBreakerCard =
    ruleBreaker?.screens.find((s) => s.ticker === ticker) ?? null;
  const qarvCard = qarv?.screens.find((s) => s.ticker === ticker) ?? null;

  // Per-ticker shard read replaces filtering the whole monolith.
  const rawTickerEvents = store.readEventsForTicker
    ? await store.readEventsForTicker(ticker)
    : [];
  // Every render below reads through the normalized shape — components
  // never see undefined arrays for sources.items, reaction.points,
  // metrics, or guidance.
  const events: EventRecord[] = normalizeEvents(rawTickerEvents, entity).sort(
    (a, b) => b.scheduledDate.localeCompare(a.scheduledDate),
  );

  // ETF details still live inside the earnings snapshot — only pay the
  // monolith-read cost when the entity actually needs it.
  const etfDetail =
    entity.securityType === "etf"
      ? (await store.readEarnings()).etfDetails?.[ticker]
      : undefined;

  // Prefer most recent PAST event for the header stamp — an upcoming
  // event has no eventDate + empty metrics, which makes the header
  // "Last: <period>" line show a future quarter with no data behind it.
  const latestPast = events.find((e) => e.eventDate);
  const latest = latestPast ?? events[0];

  // Latest source-item timestamp across all events on this ticker —
  // handed to <MarkSeen /> so localStorage stamps the exact watermark
  // being viewed. Matches shard-earnings.mjs's latestItemAt logic
  // (time → publishedAt → capturedAt fallback).
  let latestItemAt: string | undefined = undefined;
  for (const e of events) {
    for (const it of e.sources?.items ?? []) {
      const withT = it as unknown as {
        time?: string;
        publishedAt?: string;
        capturedAt?: string;
      };
      const t = withT.time ?? withT.publishedAt ?? withT.capturedAt;
      if (t && (!latestItemAt || t > latestItemAt)) latestItemAt = t;
    }
  }
  const nextEvent = events.find((e) => e.scheduledDate >= todayIso());
  const freshness = computeFreshness(
    latest?.sources.capturedAt ?? latest?.eventDate ?? latest?.scheduledDate ?? null,
  );

  // Post-earnings summaries (data/summaries/) — the store resolves any
  // member ticker to its canonical, so this call is safe from any
  // registered listing. Returns [] when the summaries dir is empty or
  // this canonical has no summary yet, which SummaryPanel renders as
  // nothing (no empty-state box, per spec).
  const rawSummaries = store.readSummariesForTicker
    ? await store.readSummariesForTicker(ticker)
    : [];
  // v1 summaries lack `kpis` / `drivers`; normalizer fills them with []
  // so SummaryPanel's `.kpis.length` / `.map` never see undefined.
  const summaries = normalizeSummaries(rawSummaries);

  // Summarize button gate: has-shard-metrics (not covered-tier). Any
  // click is deliberate interest → give the reader the best summary the
  // data allows, labeled honestly. covered.json's remaining role is
  // the nightly /sweep scope, not the on-demand path (see Task 2
  // routing rules in prompt1). The /earnings command auto-downgrades
  // to KPI-only when the primary filing can't be reached honestly;
  // it refuses when there are no shard metrics either.
  const hasSummaryForLatest =
    latestPast?.period != null && summaries.some((s) => s.period === latestPast.period);
  // Unconditional Summarize button per user directive: show on every
  // operating ticker regardless of whether the shard carries any
  // reported events, actuals, extended metrics, or SEC-filing
  // sourceLink. Only hides when a summary already exists for the
  // latest reported period (the SummaryPanel renders in that slot;
  // the Regenerate button handles the replace path).
  //
  // When the shard has no `latestPast` (freshly-listed name, upcoming-
  // only, or empty events array), the button still renders and passes
  // no period to the button component. Clicking then dispatches
  // /earnings which will WebSearch to find whether the ticker has
  // recently reported. Refusals like "RESULT: skipped — no recent
  // report" surface as no-op /earnings runs; that's an acceptable
  // cost for the personal-dashboard use case where discovery beats
  // silent UI gating.
  const showSummarizeButton =
    entity.securityType === "operating" && !hasSummaryForLatest;

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <MarkSeen ticker={ticker} latestItemAt={latestItemAt} />
      <SecurityHeader
        entity={entity}
        latest={latest}
        nextEvent={nextEvent}
        freshness={freshness}
      />

      {/* Return-to-origin chip (present when the user arrived via a
          same-origin link like /themes or /screens) + one-click
          focus toggle. Both actions live at the top of the ticker
          page so users land, see context, then act. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ReturnChip />
        <FocusToggle
          ticker={ticker}
          initialInFocus={initialInFocus}
          initialState={sharedState}
        />
      </div>

      {/* Sector-theme chips → deep-link into /themes with the sector
          card scrolled into view. Only renders tags currently present
          in the rollup — otherwise the click would land on a
          missing anchor. */}
      <SectorChips entity={entity} sectorSignals={sectorSignals} />

      {/* Cross-referenced framework signals — renders only sub-cards
          that have data for THIS ticker. Zero-signal tickers → no strip. */}
      <TickerSignals
        ticker={ticker}
        screens={{
          blueOcean: blueOceanCard,
          ruleBreaker: ruleBreakerCard,
          qarv: qarvCard,
        }}
      />

      {/* Summary panel renders above the past-quarters grid only when
          a summary exists for the latest reported period; otherwise
          nothing (no empty-state box). Non-operating types skip the
          panel entirely — /earnings only writes summaries for
          operating names. */}
      {entity.securityType === "operating" && summaries.length > 0 && (
        <SummaryPanel
          summaries={summaries}
          latestReportedPeriod={latestPast?.period ?? null}
          ticker={ticker}
        />
      )}

      {/* Extended metrics render RIGHT UNDER the AI summary — sits
          logically with Revenue/Net Income/EPS in the KPI grid rather
          than in a separate right-hand column. Only shows when the
          latest event has extendedMetrics populated (renders null when
          empty). Operating types only — matches SummaryPanel gating. */}
      {entity.securityType === "operating" && latestPast && (
        <div className="mt-4">
          <ExtendedMetricsPanel event={latestPast} />
        </div>
      )}

      {/* Guidance panel — company-issued forward statements for the
          latest reported event. Moved up from OperatingDetail so the
          "everything about this earnings" block (summary + extended
          metrics + guidance) is visually grouped. Panel only renders
          when the event's guidance[] array is non-empty. */}
      {entity.securityType === "operating" && latestPast?.guidance && latestPast.guidance.length > 0 && (
        <div className="mt-4">
          <Panel eyebrow="Guidance" padded={false}>
            <GuidanceTimeline items={latestPast.guidance} />
          </Panel>
        </div>
      )}

      {/* Summarize button — where the SummaryPanel would render but
          doesn't. Covered-tier only for now; the wider universe gets
          a mechanical/KPI-only mode later. */}
      {showSummarizeButton && (
        <SummarizeButton ticker={ticker} period={latestPast?.period ?? null} />
      )}

      {entity.securityType === "operating" && (
        <OperatingDetail entity={entity} events={events} />
      )}
      {entity.securityType === "developer" && (
        <DeveloperDetail entity={entity} events={events} />
      )}
      {entity.securityType === "etf" && (
        <EtfDetail
          entity={entity}
          detail={etfDetail}
          coveredTickers={entities.map((e) => e.ticker)}
        />
      )}

      {events.length === 0 && entity.securityType !== "etf" && (
        <EmptyState
          title="No prints on file yet"
          hint={
            entity.securityType === "developer"
              ? "This name is on the developer watchlist but no catalysts have been ingested yet — either the daily refresh hasn't run against this shard or the entity is pre-listing / delisted. Direct URL still resolves for reference."
              : "This name is data-incomplete. The next daily refresh will populate it."
          }
        />
      )}
    </div>
  );
}
