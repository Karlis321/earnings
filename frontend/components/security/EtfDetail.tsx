"use client";

import type { Entity, EtfDetail as EtfDetailData } from "@/lib/types";
import {
  Panel,
  DistributionsTable,
  HoldingsTable,
  FactPopover,
} from "@/components/primitives";
import { SecurityPriceChart } from "./SecurityPriceChart";
import { CompanyNewsPanel } from "./CompanyNewsPanel";
import Link from "next/link";

// ETF variant: price, distributions, holdings, "used as benchmark for".
// No events. Detail data (distributions + holdings) is optional — we
// still render the live price chart + news even when we haven't ingested
// the AUM / holdings package yet.

export function EtfDetail({
  entity,
  detail,
  coveredTickers,
}: {
  entity: Entity;
  detail: EtfDetailData | undefined;
  coveredTickers?: string[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <SecurityPriceChart
        ticker={entity.ticker}
        displayName={entity.displayName}
        currency={entity.currency}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-4">
          {detail?.price ? (
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
          ) : null}

          {detail?.usedAsBenchmarkFor && detail.usedAsBenchmarkFor.length > 0 ? (
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
          ) : null}

          {entity.marketCapUsd != null ? (
            <Panel eyebrow="AUM · net assets">
              <div className="font-mono text-[28px] font-semibold tabular-nums text-tx">
                ${(entity.marketCapUsd / 1e9).toFixed(2)}B
              </div>
              <div className="mt-1 text-[12.5px] text-tx-mid">
                as-of {entity.marketCapAsOf ?? "—"} · from Yahoo netAssets
              </div>
            </Panel>
          ) : null}

          <Panel eyebrow="No events">
            <div className="text-[13px] leading-[1.55] text-tx-mid">
              ETFs don&apos;t report earnings or catalysts. Coverage focuses
              on price action, distributions, and holdings composition — plus
              role as a benchmark for operating names.
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          {detail?.distributions?.length ? (
            <Panel eyebrow="Distributions · trailing" padded={false}>
              <DistributionsTable distributions={detail.distributions} />
            </Panel>
          ) : (
            <Panel eyebrow="Distributions · trailing">
              <div className="text-[12.5px] text-tx-mid">
                Distribution history not yet ingested for {entity.ticker}.
                Manually enter via admin, or wait for the specialized ETF
                fetch (not yet on the daily cron).
              </div>
            </Panel>
          )}

          {detail?.holdings?.length ? (
            <Panel eyebrow="Top holdings · click to open" padded={false}>
              <HoldingsTable
                holdings={detail.holdings}
                coveredTickers={coveredTickers}
              />
            </Panel>
          ) : (
            <Panel eyebrow="Top holdings">
              <div className="text-[12.5px] text-tx-mid">
                Holdings not yet ingested. Most fund families (iShares,
                VanEck, Amundi) publish this on their site — add ingestion
                via admin when needed.
              </div>
            </Panel>
          )}

          <CompanyNewsPanel
            displayName={entity.displayName}
            aliases={entity.aliases}
          />
        </div>
      </div>
    </div>
  );
}
