"use client";

import Link from "next/link";
import type { Entity, EventRecord } from "@/lib/types";
import {
  Card,
  MetricRow,
  MetricRowHeader,
  GuidanceTimeline,
  ReactionChart,
  Panel,
  SourceItemCard,
  Button,
} from "@/components/primitives";
import { ChevronRight } from "lucide-react";

interface Props {
  entity: Entity;
  events: EventRecord[];
}

export function OperatingDetail({ entity, events }: Props) {
  const latest = events[0];
  if (!latest) {
    return (
      <div className="rounded-panel border border-dashed border-bd bg-panel p-12 text-center text-tx-mid">
        No prints on file yet — the next daily refresh will populate this view.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-4">
        <Card
          eyebrow={`Latest print · ${latest.period}`}
          actions={
            <Link
              href={`/s/${encodeURIComponent(entity.ticker)}/e/${latest.id}`}
              className="text-[12.5px] text-brand-hi hover:text-brand-fg"
            >
              Open event →
            </Link>
          }
        >
          <MetricRowHeader />
          {latest.metrics.map((m) => (
            <MetricRow key={m.key} metric={m} />
          ))}
          {events.length > 1 ? (
            <Link
              href={`/s/${encodeURIComponent(entity.ticker)}/e/${latest.id}`}
              className="flex items-center justify-between px-[18px] py-3 text-[13px] text-tx2 hover:bg-hover2"
            >
              All {events.length - 1} earlier events
              <ChevronRight size={14} className="text-tx3" />
            </Link>
          ) : null}
        </Card>

        <Panel eyebrow="Guidance" padded={false}>
          <GuidanceTimeline items={latest.guidance} />
        </Panel>

        <Panel eyebrow="Reaction · 4-horizon">
          <ReactionChart
            points={latest.reaction.points}
            benchmark={latest.reaction.benchmark}
          />
          <div className="mt-4 font-mono text-[11.5px] text-tx-mid">
            baseline{" "}
            <span className="text-tx">{latest.reaction.baselineDate ?? "—"}</span>{" "}
            · timing{" "}
            <span className="text-tx">{latest.timing ?? "—"}</span>
          </div>
        </Panel>
      </div>

      <div className="flex flex-col gap-4">
        <Panel
          eyebrow="Latest sources"
          padded={false}
        >
          <div className="flex items-center justify-between border-b border-bd px-4 py-3 text-[12px] text-tx-mid">
            <span>
              Window {latest.sources.windowStart} → {latest.sources.windowEnd}
            </span>
            <Link
              href={`/s/${encodeURIComponent(entity.ticker)}/e/${latest.id}`}
              className="text-brand-hi hover:text-brand-fg"
            >
              All {latest.sources.items.length} →
            </Link>
          </div>
          <div className="flex flex-col gap-3 p-4">
            {latest.sources.items.slice(0, 3).map((it) => (
              <SourceItemCard key={it.id} item={it} />
            ))}
            {latest.sources.items.length === 0 && (
              <div className="p-4 text-center text-[13px] text-tx-mid">
                No sources captured yet in the window.
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
