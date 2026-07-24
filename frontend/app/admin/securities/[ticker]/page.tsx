import { notFound } from "next/navigation";
import { data } from "@/lib/data";
import { AddEditSecurityForm } from "@/components/admin/AddEditSecurityForm";

export default async function EditSecurityPage({
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
        Edit · {entity.displayName}
      </h1>
      <p className="mb-6 font-mono text-[12.5px] text-tx-mid">
        {entity.ticker} · {entity.listing}
      </p>
      <AddEditSecurityForm mode="edit" initial={entity} />
    </div>
  );
}
