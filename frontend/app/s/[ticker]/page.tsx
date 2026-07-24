import { notFound } from "next/navigation";
import { data } from "@/lib/data";
import { SecurityHeader } from "@/components/security/SecurityHeader";
import { OperatingDetail } from "@/components/security/OperatingDetail";
import { DeveloperDetail } from "@/components/security/DeveloperDetail";
import { EtfDetail } from "@/components/security/EtfDetail";
import { EmptyState } from "@/components/primitives";
import { computeFreshness } from "@/lib/freshness";

// Security Detail — three variants per FE PRD §7.3–7.5.
// Backend integration flag (P5-T6): full event data comes from /api/earnings?ticker.

interface Props {
  params: Promise<{ ticker: string }>;
}

export default async function SecurityDetailPage({ params }: Props) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const entity = data.getEntity(ticker);
  if (!entity) notFound();

  const events = data
    .getEventsForTicker(ticker)
    .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));

  const latest = events[0];
  const nextEvent = events.find((e) => e.scheduledDate >= "2026-07-24");
  const freshness = computeFreshness(
    latest?.sources.capturedAt ?? latest?.eventDate ?? latest?.scheduledDate ?? null,
  );

  return (
    <div className="mx-auto max-w-[1360px] px-10 py-8">
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
      {entity.securityType === "etf" && <EtfDetail entity={entity} />}

      {entity.securityType === "operating" && events.length === 0 && (
        <EmptyState
          title="No prints on file yet"
          hint="This name is data-incomplete. The next daily refresh will populate it."
        />
      )}
    </div>
  );
}
