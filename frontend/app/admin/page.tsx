import Link from "next/link";
import { Panel, Button, TypeBadge } from "@/components/primitives";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const entities = await store.readRegistry();
  const core = entities.filter((e) => e.isCore);
  const universe = entities.filter((e) => !e.isCore);

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

      <Panel eyebrow={`Portfolio · ${core.length} name${core.length === 1 ? "" : "s"} · isCore`}>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {core.map((e) => (
            <Link
              key={e.ticker}
              href={`/admin/securities/${encodeURIComponent(e.ticker)}`}
              className="flex items-center justify-between rounded-button border border-bd bg-s1 px-3 py-[10px] text-[13px] text-tx hover:bg-hover"
            >
              <span className="flex items-center gap-3">
                <TypeBadge type={e.securityType} size="sm" />
                <span className="font-mono text-[11px] text-brand-fg">
                  {e.ticker}
                </span>
                <span>{e.displayName}</span>
                {e.capTier && e.capTier !== "unknown" ? (
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-tx3">
                    {e.capTier}
                  </span>
                ) : null}
              </span>
              <span className="text-tx3">Edit →</span>
            </Link>
          ))}
        </div>
      </Panel>

      {universe.length > 0 ? (
        <Panel eyebrow={`Sector universe · ${universe.length} names · not on core watchlist`}>
          <details>
            <summary className="cursor-pointer text-[12.5px] text-tx-mid hover:text-tx">
              Show {universe.length} universe entities (added via
              /admin/expand or API)
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-1 md:grid-cols-2 lg:grid-cols-3">
              {universe.map((e) => (
                <Link
                  key={e.ticker}
                  href={`/admin/securities/${encodeURIComponent(e.ticker)}`}
                  className="flex items-center justify-between rounded-button border border-bd bg-s1 px-2 py-[7px] text-[12px] text-tx hover:bg-hover"
                >
                  <span className="flex items-center gap-2 overflow-hidden">
                    <TypeBadge type={e.securityType} size="sm" />
                    <span className="font-mono text-[10.5px] text-brand-fg">
                      {e.ticker}
                    </span>
                    <span className="truncate">{e.displayName}</span>
                  </span>
                  <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.08em] text-tx3">
                    {e.capTier ?? "—"}
                  </span>
                </Link>
              ))}
            </div>
          </details>
        </Panel>
      ) : null}

      <Panel eyebrow="Actions">
        <div className="flex flex-wrap gap-3">
          <Button>
            <Link href="/admin/securities/new">Add security</Link>
          </Button>
          <Button variant="secondary">
            <Link href="/admin/expand">Expand watchlist (Yahoo screener)</Link>
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
