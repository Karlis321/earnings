import { notFound } from "next/navigation";
import { store } from "@/server/store";
import {
  findEntity,
  eventsForTicker,
} from "@/server/lib/registryHelpers";
import { ManualEntryForm } from "@/components/admin/ManualEntryForm";
import { CoverageGrid } from "@/components/admin/CoverageGrid";

export const dynamic = "force-dynamic";

export default async function ManualEntryPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const [entities, snapshot] = await Promise.all([
    store.readRegistry(),
    store.readEarnings(),
  ]);
  const entity = findEntity(entities, ticker);
  if (!entity) notFound();

  const events = eventsForTicker(snapshot, ticker);

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
      <CoverageGrid entity={entity} events={events} />
      <ManualEntryForm entity={entity} events={events} />
    </div>
  );
}
