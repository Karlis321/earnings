"use client";

import { useState } from "react";
import Link from "next/link";
import type { Entity, EventRecord, MetricEntry } from "@/lib/types";
import {
  Card,
  MetricRow,
  MetricRowHeader,
  GuidanceTimeline,
  ReactionChart,
  ReactionRow,
  Panel,
  SourceItemCard,
  SurprisePill,
} from "@/components/primitives";
import { SecurityPriceChart } from "./SecurityPriceChart";
import { CompanyNewsPanel } from "./CompanyNewsPanel";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  groupOf,
  isDerivedMetric,
  metricGroupLabel,
  METRIC_GROUP_ORDER,
  type MetricGroup,
} from "@/lib/metricGroups";

interface Props {
  entity: Entity;
  events: EventRecord[];
}

export function OperatingDetail({ entity, events }: Props) {
  // Events arrive sorted DESC by scheduledDate. Split upcoming from past
  // so "Latest print" always shows a reported quarter — showing metric
  // rows full of "—" for an unreleased event is confusing.
  const upcoming = events.find((e) => !e.eventDate);
  const pastEvents = events.filter((e) => e.eventDate);
  const latestPast = pastEvents[0];
  const primary = latestPast ?? upcoming ?? events[0];

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!primary) {
    return (
      <div>
        <SecurityPriceChart
          ticker={entity.ticker}
          displayName={entity.displayName}
          currency={entity.currency}
        />
        <div className="mt-4 rounded-panel border border-dashed border-bd bg-panel p-12 text-center text-tx-mid">
          No prints on file yet — the next daily refresh will populate this view.
        </div>
      </div>
    );
  }
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
          <Panel eyebrow={`Next reporting · ${upcoming.period}`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-[16px] font-semibold text-tx">
                  {upcoming.scheduledDate}
                  {upcoming.timing ? (
                    <span className="ml-2 text-[12.5px] font-normal text-tx-mid">
                      · {upcoming.timing}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-[12.5px] text-tx-mid">
                  Watchlist window opens 2 days ahead — sources start
                  accruing then.
                </div>
              </div>
              <Link
                href={`/s/${encodeURIComponent(entity.ticker)}/e/${upcoming.id}`}
                className="text-[12.5px] text-brand-hi hover:text-brand-fg"
              >
                Open event →
              </Link>
            </div>
          </Panel>
        ) : null}
        {latestPast ? (
          <Card
            eyebrow={`Latest print · ${latestPast.period}`}
            actions={
              <Link
                href={`/s/${encodeURIComponent(entity.ticker)}/e/${latestPast.id}`}
                className="text-[12.5px] text-brand-hi hover:text-brand-fg"
              >
                Open event →
              </Link>
            }
          >
            <MetricRowHeader />
            {latestPast.metrics.map((m) => (
              <MetricRow key={m.key} metric={m} />
            ))}
            {pastEvents.length > 1 ? (
              <Link
                href={`/s/${encodeURIComponent(entity.ticker)}/e/${latestPast.id}`}
                className="flex items-center justify-between px-[18px] py-3 text-[13px] text-tx2 hover:bg-hover2"
              >
                All {pastEvents.length - 1} earlier prints
                <ChevronRight size={14} className="text-tx3" />
              </Link>
            ) : null}
          </Card>
        ) : null}

        {pastEvents.length > 1 ? (
          <Panel
            eyebrow={`Past quarters · ${pastEvents.length}`}
            padded={false}
          >
            <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_1fr_auto_auto] gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
              <span className="w-3" />
              <span>Period</span>
              <span>Reported</span>
              <span className="text-right">Revenue</span>
              <span className="text-right">Net income</span>
              <span className="text-right">EPS actual</span>
              <span className="text-right">Surprise</span>
              <span className="text-right">Open</span>
            </div>
            {pastEvents.map((e) => {
              const eps = e.metrics.find((m) => /eps/i.test(m.key));
              const rev = e.metrics.find(
                (m) => m.key === "revenue_usd_m",
              );
              const netInc = e.metrics.find(
                (m) => m.key === "net_income_usd_m",
              );
              const actual = eps?.actual?.value;
              const surp = eps?.surprisePct;
              const isOpen = expandedIds.has(e.id);
              const Chevron = isOpen ? ChevronDown : ChevronRight;
              return (
                <div
                  key={e.id}
                  className="border-b border-bd last:border-b-0"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpanded(e.id)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        toggleExpanded(e.id);
                      }
                    }}
                    aria-expanded={isOpen}
                    className="grid cursor-pointer grid-cols-[auto_1fr_1fr_1fr_1fr_1fr_auto_auto] items-center gap-3 px-4 pt-3 text-[12.5px] hover:bg-hover"
                  >
                    <Chevron size={14} className="text-tx3" />
                    <span className="text-tx">{e.period}</span>
                    <span className="font-mono text-[12px] text-tx-mid">
                      {e.eventDate ?? e.scheduledDate}
                    </span>
                    <span className="text-right font-mono tabular-nums text-tx-mid">
                      {rev?.actual?.value != null
                        ? Math.round(rev.actual.value).toLocaleString()
                        : "—"}
                    </span>
                    <span className="text-right font-mono tabular-nums text-tx-mid">
                      {netInc?.actual?.value != null
                        ? Math.round(netInc.actual.value).toLocaleString()
                        : "—"}
                    </span>
                    <span className="text-right font-mono tabular-nums text-tx">
                      {actual != null ? actual.toFixed(3) : "—"}
                    </span>
                    <span className="text-right">
                      <SurprisePill
                        surprisePct={surp ?? null}
                        hasActual={actual != null}
                        compact
                      />
                    </span>
                    <span className="text-right font-mono text-[11.5px] text-tx3">
                      <Link
                        href={`/s/${encodeURIComponent(entity.ticker)}/e/${e.id}`}
                        onClick={(ev) => ev.stopPropagation()}
                        className="text-brand-hi hover:text-brand-fg"
                      >
                        Open event ↗
                      </Link>
                    </span>
                  </div>
                  {isOpen ? (
                    <div className="border-t border-bd bg-panel2 px-4 py-3">
                      <ExpandedMetricGrid metrics={e.metrics} />
                      {e.sourceLink ? (
                        <div className="mt-2 font-mono text-[11px] text-tx3">
                          <a
                            href={e.sourceLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(ev) => ev.stopPropagation()}
                            className="text-brand-hi hover:text-brand-fg"
                          >
                            {e.sourceLink.kind === "filing"
                              ? "Open filing ↗"
                              : "Check the source ↗"}
                          </a>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="px-4 pb-3 pt-1">
                    <ReactionRow points={e.reaction?.points ?? []} />
                  </div>
                </div>
              );
            })}
          </Panel>
        ) : null}

        <Panel eyebrow="Guidance" padded={false}>
          <GuidanceTimeline items={primary.guidance} />
        </Panel>

        <Panel eyebrow="Reaction · 4-horizon">
          <ReactionChart
            points={primary.reaction.points}
            benchmark={primary.reaction.benchmark}
          />
          <div className="mt-4 font-mono text-[11.5px] text-tx-mid">
            baseline{" "}
            <span className="text-tx">{primary.reaction.baselineDate ?? "—"}</span>{" "}
            · timing{" "}
            <span className="text-tx">{primary.timing ?? "—"}</span>
          </div>
        </Panel>
      </div>

      <div className="flex flex-col gap-4">
        <CompanyNewsPanel
          ticker={entity.ticker}
          displayName={entity.displayName}
        />
        <Panel
          eyebrow="Latest sources"
          padded={false}
        >
          <div className="flex items-center justify-between border-b border-bd px-4 py-3 text-[12px] text-tx-mid">
            <span>
              Window {primary.sources.windowStart} → {primary.sources.windowEnd}
            </span>
            <Link
              href={`/s/${encodeURIComponent(entity.ticker)}/e/${primary.id}`}
              className="text-brand-hi hover:text-brand-fg"
            >
              All {primary.sources.items.length} →
            </Link>
          </div>
          <div className="flex flex-col gap-3 p-4">
            {primary.sources.items.slice(0, 3).map((it) => (
              <SourceItemCard key={it.id} item={it} />
            ))}
            {primary.sources.items.length === 0 && (
              <div className="p-4 text-center text-[13px] text-tx-mid">
                No sources captured yet in the window.
              </div>
            )}
          </div>
        </Panel>
      </div>
      </div>
    </div>
  );
}

// Compact grouped-metric view used inside the past-quarters expand row.
// Renders the same 4-panel split as the event-detail page, but denser
// (single-line per metric, no separate headers per panel).
function ExpandedMetricGrid({ metrics }: { metrics: MetricEntry[] }) {
  const buckets = new Map<MetricGroup, MetricEntry[]>();
  for (const m of metrics) {
    const isDerivedFact =
      (m.actual as { derived?: boolean } | null)?.derived === true;
    const g = groupOf(m.key, isDerivedFact);
    const arr = buckets.get(g) ?? [];
    arr.push(m);
    buckets.set(g, arr);
  }
  const active = METRIC_GROUP_ORDER.filter(
    (g) => (buckets.get(g)?.length ?? 0) > 0,
  );
  if (active.length === 0) {
    return (
      <div className="text-[12px] text-tx-mid">
        No metrics on file for this quarter.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {active.map((g) => {
        const rows = buckets.get(g)!;
        const isDerivedPanel = g === "derived";
        return (
          <div
            key={g}
            className="rounded-panel border border-bd bg-panel"
          >
            <div className="border-b border-bd px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-tx3">
              {metricGroupLabel(g)}
            </div>
            <div className="flex flex-col">
              {rows.map((m) => {
                const isDerivedFact =
                  (m.actual as { derived?: boolean } | null)?.derived === true;
                const derived =
                  isDerivedPanel || isDerivedMetric(m.key, isDerivedFact);
                const val = m.actual?.value;
                const displayVal =
                  val == null
                    ? "—"
                    : Math.abs(val) < 1000
                    ? val.toFixed(2)
                    : Math.round(val).toLocaleString();
                return (
                  <div
                    key={m.key}
                    className={
                      "flex items-center justify-between gap-2 border-b border-bd px-3 py-[6px] text-[12px] last:border-b-0" +
                      (derived ? " opacity-70" : "")
                    }
                  >
                    <span className="flex items-center gap-2 text-tx">
                      {m.displayLabel}
                      {derived ? (
                        <span className="rounded-[3px] bg-s3 px-[5px] py-[1px] font-mono text-[9px] uppercase tracking-[0.08em] text-tx-mid">
                          derived
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono tabular-nums text-tx">
                      {displayVal}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
