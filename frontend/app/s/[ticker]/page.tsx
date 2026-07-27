import { notFound } from "next/navigation";
import { store } from "@/server/store";
import { findEntity, eventsForTicker } from "@/server/lib/registryHelpers";
import { SecurityHeader } from "@/components/security/SecurityHeader";
import { OperatingDetail } from "@/components/security/OperatingDetail";
import { DeveloperDetail } from "@/components/security/DeveloperDetail";
import { EtfDetail } from "@/components/security/EtfDetail";
import { EmptyState } from "@/components/primitives";
import { computeFreshness, todayIso } from "@/lib/freshness";

// Security Detail — three variants per FE PRD §7.3–7.5.

interface Props {
  params: Promise<{ ticker: string }>;
}

export const dynamic = "force-dynamic";

export default async function SecurityDetailPage({ params }: Props) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const [entities, snapshot] = await Promise.all([
    store.readRegistry(),
    store.readEarnings(),
  ]);
  const entity = findEntity(entities, ticker);
  if (!entity) notFound();

  const events = eventsForTicker(snapshot, ticker);
  // Prefer most recent PAST event for the header stamp — an upcoming
  // event has no eventDate + empty metrics, which makes the header
  // "Last: <period>" line show a future quarter with no data behind it.
  const latestPast = events.find((e) => e.eventDate);
  const latest = latestPast ?? events[0];
  const nextEvent = events.find((e) => e.scheduledDate >= todayIso());
  const freshness = computeFreshness(
    latest?.sources.capturedAt ?? latest?.eventDate ?? latest?.scheduledDate ?? null,
  );

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <SecurityHeader
        entity={entity}
        latest={latest}
        nextEvent={nextEvent}
        freshness={freshness}
      />

      {entity.securityType === "operating" && (
        <OperatingDetail entity={entity} events={events} />
      )}
      {entity.securityType === "developer" && (
        <DeveloperDetail entity={entity} events={events} />
      )}
      {entity.securityType === "etf" && (
        <EtfDetail
          entity={entity}
          detail={snapshot.etfDetails?.[ticker]}
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
