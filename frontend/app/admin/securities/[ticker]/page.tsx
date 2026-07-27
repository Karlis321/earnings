import { notFound } from "next/navigation";
import { store } from "@/server/store";
import { findEntity } from "@/server/lib/registryHelpers";
import { AddEditSecurityForm } from "@/components/admin/AddEditSecurityForm";

export const dynamic = "force-dynamic";

export default async function EditSecurityPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw);
  const entities = await store.readRegistry();
  const entity = findEntity(entities, ticker);
  if (!entity) notFound();
  return (
    <div>
      <h1 className="mb-1 text-[22px] font-semibold tracking-[-0.02em]">
        Edit · {entity.displayName}
      </h1>
      <p className="mb-6 font-mono text-[12.5px] text-tx-mid">
        {entity.ticker} · {entity.listing}
      </p>
      <AddEditSecurityForm mode="edit" initial={entity} />
    </div>
  );
}
