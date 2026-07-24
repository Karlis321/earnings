"use client";

import type { Entity } from "@/lib/types";
import {
  Panel,
  DistributionsTable,
  HoldingsTable,
  FactPopover,
} from "@/components/primitives";
import { data } from "@/lib/data";
import Link from "next/link";
import { fmtMoney } from "@/lib/format";

// ETF variant: price, distributions, holdings, "used as benchmark for".
// No events. Friendly no-events state. (FE PRD §7.5)

export function EtfDetail({ entity }: { entity: Entity }) {
  const detail = data.getEtfDetail(entity.ticker);
  if (!detail) {
    return (
      <Panel eyebrow="ETF · no data on file">
        <div className="text-tx-mid">
          No fixture ETF data for {entity.ticker}.
        </div>
      </Panel>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
      <div className="flex flex-col gap-4">
        <Panel eyebrow="Price · last close">
          <FactPopover fact={detail.price}>
            <div className="cursor-help">
              <div className="font-mono text-[36px] font-semibold tabular-nums text-tx">
                ${detail.price.value?.toFixed(2)}
              </div>
              <div className="mt-1 text-[12.5px] text-tx-mid">
                as-of {detail.price.asOf}
              </div>
            </div>
          </FactPopover>
        </Panel>

        {detail.usedAsBenchmarkFor.length > 0 && (
          <Panel eyebrow="Used as benchmark for">
            <div className="flex flex-wrap gap-[6px]">
              {detail.usedAsBenchmarkFor.map((t) => (
                <Link
                  key={t}
                  href={`/s/${encodeURIComponent(t)}`}
                  className="inline-flex h-[26px] items-center rounded-[6px] border border-bd2 bg-s2 px-[10px] font-mono text-[12px] text-brand-fg hover:bg-s3"
                >
                  {t}
                </Link>
              ))}
            </div>
          </Panel>
        )}

        <Panel eyebrow="No events" >
          <div className="text-[13px] leading-[1.55] text-tx-mid">
            ETFs don't report earnings or catalysts. Coverage focuses on price
            action, distributions, and holdings composition — plus role as a
            benchmark for operating names.
          </div>
        </Panel>
      </div>

      <div className="flex flex-col gap-4">
        <Panel eyebrow="Distributions · trailing" padded={false}>
          <DistributionsTable distributions={detail.distributions} />
        </Panel>

        <Panel eyebrow="Top holdings" padded={false}>
          <HoldingsTable holdings={detail.holdings} />
        </Panel>
      </div>
    </div>
  );
}
