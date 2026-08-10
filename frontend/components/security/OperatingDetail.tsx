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
import { fmtMoney } from "@/lib/format";
import {
  groupOf,
  isDerivedMetric,
  metricGroupLabel,
  METRIC_GROUP_ORDER,
  type MetricGroup,
} from "@/lib/metricGroups";

// Heuristic: an eventDate is "estimated" (shell placeholder) when the
// row's source is a fallback URL rather than a filing. The July-2026
// audit found 1,765 past events on the mid-month 15th (Yahoo cadence
// projections); 97% of those had `sourceLink.kind === "fallback"` —
// so filing-kind is the reliable positive signal for a real filed
// date. When we can't confirm a real filed date, render "~Mmm YYYY
// (est.)" rather than a hard date — that's a ledger violation to
// invent precision.
function isEstimatedEventDate(ev: EventRecord): boolean {
  if (!ev.eventDate) return false;
  if (ev.sourceLink?.kind === "filing") return false;
  // Backfilled real report dates from Yahoo earningsChart.reportedDate
  // are just as trustworthy as an SEC filing date — they're the
  // exchange-published release date, not a quarter-end placeholder.
  const eventDateSource = (ev as EventRecord & { eventDateSource?: string })
    .eventDateSource;
  if (eventDateSource === "yahoo-earnings-chart-reportedDate") return false;
  // sec-* provenances that carry a real filed date via the shard's
  // accession/form are trustworthy even without a filing-kind sourceLink.
  const trusted = new Set([
    "sec-submissions",
    "filing_manual",
    "bloomberg_manual",
    "llm_extracted",
  ]);
  if (ev.provenance && trusted.has(ev.provenance)) return false;
  return true;
}

function fmtEstDate(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString(undefined, { month: "short" });
  return `~${month} ${d.getUTCFullYear()} (est.)`;
}

// EPS renderer: use fmtMoney's currency-aware format (KRW/JPY/etc.
// get a prefix; USD stays bare). Cap at 2 dp for values > 1 —
// ".700" trailing zeros are false precision. fmtMoney does most of
// this; wrap it so callers pass just (value, unit).
function fmtEps(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) < 10) {
    // Under $10 EPS is the common case for USD-primary; 2 dp reads
    // as the release does ("$0.48" not "$0.480").
    const rounded = value.toFixed(2);
    const prefix = unit && unit !== "USD" && /^[A-Z]{3}$/.test(unit) ? `${unit} ` : "";
    return `${prefix}${rounded}`;
  }
  // KRW / JPY EPS values like 62,700 read as integer with prefix.
  return fmtMoney(value, unit ?? "USD", false);
}

// Reaction +1d headline value: read the d1 point, return colored
// string + a status flag so the caller can style. Terminal
// unavailable states render muted; nulls without a status marker
// show "—" as before (the maturation script backfill is a separate
// task; UI doesn't invent state).
type ReactionCellState = "value" | "pending" | "unavailable";
function reactionD1(ev: EventRecord): { text: string; state: ReactionCellState; positive: boolean | null } {
  const p = ev.reaction?.points?.find((x) => x.horizon === "d1");
  if (!p) return { text: "—", state: "unavailable", positive: null };
  if (p.absReturn == null) {
    const status = (p as { status?: string }).status;
    if (status === "unavailable") return { text: "n/a", state: "unavailable", positive: null };
    return { text: "—", state: "pending", positive: null };
  }
  const pct = p.absReturn * 100;
  const sign = pct >= 0 ? "+" : "";
  return {
    text: `${sign}${pct.toFixed(1)}%`,
    state: "value",
    positive: pct >= 0,
  };
}

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
            {/* Column layout matches the header + body grids exactly.
                Left → right: expand chevron, Period, Reported (or est),
                Revenue, Net income, EPS, Beat/miss, Reaction +1d, Open. */}
            <div className="grid grid-cols-[24px_minmax(80px,1fr)_minmax(120px,1.2fr)_minmax(80px,1fr)_minmax(80px,1fr)_minmax(80px,1fr)_[beat-miss]140px_[reaction]80px_[open]60px] items-center gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
              <span />
              <span>Period</span>
              <span>Reported</span>
              <span className="text-right">Revenue</span>
              <span className="text-right">Net income</span>
              <span className="text-right">EPS</span>
              <span className="text-right">Beat/miss</span>
              <span className="text-right">Reaction +1d</span>
              <span className="text-right">Open</span>
            </div>
            {pastEvents.map((e) => {
              const eps = e.metrics.find((m) => /eps/i.test(m.key));
              const rev = e.metrics.find((m) => m.key === "revenue_usd_m");
              const netInc = e.metrics.find(
                (m) => m.key === "net_income_usd_m",
              );
              const revenueEstimate = rev?.estimate?.value;
              const epsActual = eps?.actual?.value;
              const epsUnit = eps?.actual?.unit ?? null;
              // Row-level Beat/miss now prefers REVENUE surprise over
              // EPS. Revenue misses drive the biggest actual reactions
              // (misses trigger sell-offs faster than EPS misses do),
              // and EPS often falls into the cross-basis suppression
              // bucket (SEC GAAP actual vs Yahoo adjusted-EPS estimate
              // — see Stage 1B invariant in CLAUDE.md). Revenue is
              // usually reported on the same basis by both sides.
              // Fall back to EPS when revenue estimate isn't on file.
              const rowSurprise =
                rev?.surprisePct ?? eps?.surprisePct ?? null;
              const rowHasActual =
                (rev?.actual?.value ?? null) != null ||
                (eps?.actual?.value ?? null) != null;
              const reaction = reactionD1(e);
              const estimated = isEstimatedEventDate(e);
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
                    className="grid cursor-pointer grid-cols-[24px_minmax(80px,1fr)_minmax(120px,1.2fr)_minmax(80px,1fr)_minmax(80px,1fr)_minmax(80px,1fr)_[beat-miss]140px_[reaction]80px_[open]60px] items-center gap-3 px-4 py-2.5 text-[12.5px] hover:bg-hover"
                  >
                    <Chevron size={14} className="text-tx3" />
                    <span className="text-tx">{e.period}</span>
                    <span
                      className={
                        "font-mono text-[12px] " +
                        (estimated
                          ? "text-tx3 italic"
                          : "text-tx-mid")
                      }
                      title={
                        estimated
                          ? "Report date is an estimator placeholder — company release URL not yet linked in the shard"
                          : undefined
                      }
                    >
                      {e.eventDate
                        ? estimated
                          ? fmtEstDate(e.eventDate)
                          : e.eventDate
                        : e.scheduledDate}
                    </span>
                    <span className="text-right font-mono tabular-nums text-tx-mid">
                      {rev?.actual?.value != null
                        ? fmtMoney(
                            rev.actual.value,
                            rev.actual.unit ?? "USD",
                            (rev.actual.unit ?? "USD").endsWith("_m") ||
                              rev.key.endsWith("_m"),
                          )
                        : "—"}
                    </span>
                    <span className="text-right font-mono tabular-nums text-tx-mid">
                      {netInc?.actual?.value != null
                        ? fmtMoney(
                            netInc.actual.value,
                            netInc.actual.unit ?? "USD",
                            (netInc.actual.unit ?? "USD").endsWith("_m") ||
                              netInc.key.endsWith("_m"),
                          )
                        : "—"}
                    </span>
                    <span className="text-right font-mono tabular-nums text-tx">
                      {fmtEps(epsActual ?? null, epsUnit)}
                    </span>
                    <span className="text-right">
                      <SurprisePill
                        surprisePct={rowSurprise}
                        hasActual={rowHasActual}
                        compact
                      />
                    </span>
                    <ReactionD1Cell reaction={reaction} />
                    <span className="text-right font-mono text-[11px] text-tx3">
                      <Link
                        href={`/s/${encodeURIComponent(entity.ticker)}/e/${e.id}`}
                        onClick={(ev) => ev.stopPropagation()}
                        className="text-tx-mid underline decoration-bd underline-offset-2 hover:text-tx hover:decoration-tx2"
                      >
                        Open ↗
                      </Link>
                    </span>
                  </div>
                  {isOpen ? (
                    <div className="border-t border-bd bg-panel2 px-4 py-3">
                      {/* Full-width reaction sub-row — attached to its
                          quarter, not floating under Period. Muted so
                          the +1d headline column stays the primary
                          reading of the row. */}
                      <div className="mb-3 flex items-center gap-3 rounded-[6px] border border-bd bg-panel px-3 py-2">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
                          Reaction (all horizons)
                        </span>
                        <ReactionRow points={e.reaction?.points ?? []} />
                      </div>
                      <ExpandedMetricGrid metrics={e.metrics} />
                      {revenueEstimate != null ? (
                        <div className="mt-2 font-mono text-[11px] text-tx3">
                          revenue estimate on file (from{" "}
                          {rev?.estimate?.source?.provenance ?? "?"})
                        </div>
                      ) : null}
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
                </div>
              );
            })}
          </Panel>
        ) : null}

        {primary.guidance && primary.guidance.length > 0 ? (
          <Panel eyebrow="Guidance" padded={false}>
            <GuidanceTimeline items={primary.guidance} />
          </Panel>
        ) : null}

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
        {/* ExtendedMetricsPanel moved up to sit directly under the AI
            summary card in page.tsx — keeps "extra KPIs" visually
            grouped with the standard KPI grid instead of stranded in
            the right-hand column below the reaction chart. */}
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
                const unit = m.actual?.unit ?? "USD";
                const looksLikeCurrency = /^[A-Z]{3}(_m)?$/.test(unit);
                const storedInMillions =
                  m.key.endsWith("_m") || unit.endsWith("_m");
                const displayVal =
                  val == null
                    ? "—"
                    : looksLikeCurrency
                    ? fmtMoney(val, unit, storedInMillions)
                    : Math.abs(val) < 10
                    ? val.toFixed(2)
                    : Math.abs(val) < 100
                    ? val.toFixed(1)
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

// Reaction +1d headline cell. Colored by direction (green for positive
// move, red for negative, muted for terminal-unavailable, muted "—"
// for still-pending). "Reaction" is deliberately the label — analysts
// reading the table can't misread it against "surprise", which is
// reserved for actual-vs-estimate throughout the app.
function ReactionD1Cell({
  reaction,
}: {
  reaction: { text: string; state: "value" | "pending" | "unavailable"; positive: boolean | null };
}) {
  const base = "text-right font-mono tabular-nums text-[12.5px]";
  if (reaction.state === "unavailable") {
    return (
      <span
        className={base + " text-tx3"}
        title="Reaction data unavailable — Yahoo bars never covered this event's window"
      >
        {reaction.text}
      </span>
    );
  }
  if (reaction.state === "pending") {
    return (
      <span
        className={base + " text-tx3"}
        title="Reaction still pending — will populate as trading days elapse"
      >
        {reaction.text}
      </span>
    );
  }
  const color = reaction.positive ? "text-success-fg" : "text-danger";
  return <span className={base + " " + color + " font-semibold"}>{reaction.text}</span>;
}
