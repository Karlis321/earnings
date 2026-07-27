import Link from "next/link";
import { Panel, Button } from "@/components/primitives";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const entities = await store.readRegistry();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
          Admin
        </h1>
        <p className="mt-1 text-[13.5px] text-tx-mid">
          Configure coverage, enter the manual data layer, manage sources.
        </p>
      </div>

      <Panel eyebrow={`Coverage · ${entities.length} name${entities.length === 1 ? "" : "s"}`}>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {entities.map((e) => (
            <Link
              key={e.ticker}
              href={`/admin/securities/${encodeURIComponent(e.ticker)}`}
              className="flex items-center justify-between rounded-button border border-bd bg-s1 px-3 py-[10px] text-[13px] text-tx hover:bg-hover"
            >
              <span className="flex items-center gap-3">
                <span className="font-mono text-[11px] text-brand-fg">
                  {e.ticker}
                </span>
                <span>{e.displayName}</span>
              </span>
              <span className="text-tx3">Edit →</span>
            </Link>
          ))}
        </div>
      </Panel>

      <Panel eyebrow="Actions">
        <div className="flex flex-wrap gap-3">
          <Button>
            <Link href="/admin/securities/new">Add security</Link>
          </Button>
          <Button variant="secondary">
            <Link href="/admin/sources">Manage custom sources</Link>
          </Button>
          <Button variant="secondary">
            <Link href="/admin/feedback">Feedback & signals</Link>
          </Button>
        </div>
      </Panel>
    </div>
  );
}
