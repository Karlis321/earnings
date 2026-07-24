import { notFound } from "next/navigation";
import { data } from "@/lib/data";
import { ManualEntryForm } from "@/components/admin/ManualEntryForm";

export default async function ManualEntryPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const entity = data.getEntity(ticker);
  if (!entity) notFound();

  return (
    <div>
      <h1 className="mb-1 text-[22px] font-semibold tracking-[-0.02em]">
        Manual value entry
      </h1>
      <p className="mb-6 text-[13px] text-tx-mid">
        For fields FMP/Yahoo can't cover. Source and as-of are mandatory —
        entries that skip them are blocked inline.
      </p>
      <ManualEntryForm entity={entity} />
    </div>
  );
}
