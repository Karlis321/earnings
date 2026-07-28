import { notFound } from "next/navigation";
import { store } from "@/server/store";
import { findEntity } from "@/server/lib/registryHelpers";
import { AdminEntryPanel } from "@/components/admin/AdminEntryPanel";

export const dynamic = "force-dynamic";

export default async function ManualEntryPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const [entities, tickerEvents] = await Promise.all([
    store.readRegistry(),
    store.readEventsForTicker
      ? store.readEventsForTicker(ticker)
      : Promise.resolve([]),
  ]);
  const entity = findEntity(entities, ticker);
  if (!entity) notFound();

  const events = tickerEvents
    .slice()
    .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="mb-1 text-[22px] font-semibold tracking-[-0.02em]">
          Manual value entry
        </h1>
        <p className="text-[13px] text-tx-mid">
          For fields FMP/Yahoo can't cover. Source and as-of are mandatory —
          entries that skip them are blocked inline.
        </p>
      </div>
      <AdminEntryPanel entity={entity} events={events} />
    </div>
  );
}
