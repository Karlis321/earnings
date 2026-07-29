import { notFound } from "next/navigation";
import { store } from "@/server/store";
import { findEntity } from "@/server/lib/registryHelpers";
import { SecurityHeader } from "@/components/security/SecurityHeader";
import { OperatingDetail } from "@/components/security/OperatingDetail";
import { DeveloperDetail } from "@/components/security/DeveloperDetail";
import { EtfDetail } from "@/components/security/EtfDetail";
import { SummaryPanel } from "@/components/security/SummaryPanel";
import { EmptyState } from "@/components/primitives";
import { computeFreshness, todayIso } from "@/lib/freshness";
import type { EventRecord } from "@/lib/types";

// Security Detail — three variants per FE PRD §7.3–7.5.

interface Props {
  params: Promise<{ ticker: string }>;
}

export const dynamic = "force-dynamic";

export default async function SecurityDetailPage({ params }: Props) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const entities = await store.readRegistry();
  const entity = findEntity(entities, ticker);
  if (!entity) notFound();

  // Per-ticker shard read replaces filtering the whole monolith.
  const tickerEvents = store.readEventsForTicker
    ? await store.readEventsForTicker(ticker)
    : [];
  const events: EventRecord[] = tickerEvents
    .slice()
    .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));

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
  const nextEvent = events.find((e) => e.scheduledDate >= todayIso());
  const freshness = computeFreshness(
    latest?.sources.capturedAt ?? latest?.eventDate ?? latest?.scheduledDate ?? null,
  );

  // Post-earnings summaries (data/summaries/) — the store resolves any
  // member ticker to its canonical, so this call is safe from any
  // registered listing. Returns [] when the summaries dir is empty or
  // this canonical has no summary yet, which SummaryPanel renders as
  // nothing (no empty-state box, per spec).
  const summaries = store.readSummariesForTicker
    ? await store.readSummariesForTicker(ticker)
    : [];

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <SecurityHeader
        entity={entity}
        latest={latest}
        nextEvent={nextEvent}
        freshness={freshness}
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
        />
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

      {entity.securityType === "operating" && events.length === 0 && (
        <EmptyState
          title="No prints on file yet"
          hint="This name is data-incomplete. The next daily refresh will populate it."
        />
      )}
    </div>
  );
}
