"use client";

import Link from "next/link";
import type { Entity, EventRecord } from "@/lib/types";
import {
  Panel,
  ReactionChart,
  SourceItemCard,
  CatalystCard,
  ExpectationTag,
} from "@/components/primitives";
import { SecurityPriceChart } from "./SecurityPriceChart";
import { CompanyNewsPanel } from "./CompanyNewsPanel";
import { fmtDate } from "@/lib/format";

// Developer variant: never show earnings/estimate/miss-beat.
// Next-catalyst callout, catalyst cards, reaction, sources. (FE PRD §7.4)

interface Props {
  entity: Entity;
  events: EventRecord[];
}

export function DeveloperDetail({ entity, events }: Props) {
  const upcoming = events.find((e) => !e.eventDate);
  return (
    <div className="flex flex-col gap-4">
      <SecurityPriceChart
        ticker={entity.ticker}
        displayName={entity.displayName}
        currency={entity.currency}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-4">
        {upcoming ? (
          <Panel eyebrow="Next expected catalyst">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[16px] font-semibold text-tx">
                  {upcoming.catalystType} · {upcoming.period}
                </div>
                <div className="mt-1 text-[12.5px] text-tx-mid">
                  Expected {fmtDate(upcoming.scheduledDate)}
                </div>
              </div>
              <ExpectationTag expectation={upcoming.expectation} />
            </div>
          </Panel>
        ) : null}

        {events.flatMap((e) => e.catalysts ?? []).length > 0 && (
          <Panel eyebrow="Catalysts">
            <div className="grid grid-cols-1 gap-3">
              {events.flatMap((e) =>
                (e.catalysts ?? []).map((c, i) => (
                  <CatalystCard key={`${e.id}-${i}`} catalyst={c} />
                )),
              )}
            </div>
          </Panel>
        )}

        <Panel eyebrow="Reaction · 4-horizon">
          {events[0] ? (
            <ReactionChart
              points={events[0].reaction.points}
              benchmark={events[0].reaction.benchmark}
            />
          ) : (
            <div className="text-tx-mid">
              No completed catalysts yet — reaction populates once the event
              lands.
            </div>
          )}
        </Panel>
      </div>

      <div className="flex flex-col gap-4">
        <CompanyNewsPanel
          ticker={entity.ticker}
          displayName={entity.displayName}
        />
        <Panel eyebrow="Latest sources" padded={false}>
          <div className="flex flex-col gap-3 p-4">
            {events[0]?.sources.items.length ? (
              events[0].sources.items.map((it) => (
                <SourceItemCard key={it.id} item={it} />
              ))
            ) : (
              <div className="p-4 text-center text-[13px] text-tx-mid">
                No sources captured in the current window.
              </div>
            )}
          </div>
        </Panel>
      </div>
      </div>
    </div>
  );
}
