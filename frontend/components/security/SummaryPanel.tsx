import Link from "next/link";
import clsx from "clsx";
import { ArrowUpRight, AlertTriangle, ArrowUp, ArrowDown, Minus } from "lucide-react";
import type { Summary, SummaryDirection } from "@/lib/types";
import { OlderSummaries } from "./OlderSummaries";

interface Props {
  summaries: Summary[]; // sorted latest-first
  latestReportedPeriod?: string | null;
}

// The panel renders only when a summary exists for the latest reported
// period — matches the acceptance rule ("no summary → render nothing").
// Older-period summaries collapse into an expandable list below.
export function SummaryPanel({ summaries, latestReportedPeriod }: Props) {
  if (summaries.length === 0) return null;
  const latest = summaries[0];
  // If the caller told us the latest reported period, gate on that.
  // Otherwise assume summaries[0] is authoritative (single-summary shape).
  if (latestReportedPeriod && latest.period !== latestReportedPeriod) return null;

  const older = summaries.slice(1);
  return (
    <section className="mt-6" aria-labelledby="summary-panel-headline">
      <SummaryCard summary={latest} />
      {older.length > 0 ? <OlderSummaries summaries={older} /> : null}
    </section>
  );
}

// Split so the same layout renders both the top summary and (in the
// expandable list) any older one — the compact list flag adjusts a
// couple of spacings and hides the KPI grid for readability.
export function SummaryCard({
  summary,
  compact = false,
}: {
  summary: Summary;
  compact?: boolean;
}) {
  return (
    <article
      className={clsx(
        "rounded-[10px] border border-bd bg-panel",
        compact ? "px-5 py-4" : "px-6 py-5",
      )}
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
            AI summary · {summary.period} · reported {summary.reported_at}
          </p>
          <h2
            id={compact ? undefined : "summary-panel-headline"}
            className="mt-1 text-[19px] font-semibold leading-tight text-tx"
          >
            {summary.headline}
          </h2>
        </div>
      </header>

      {!compact && summary.kpis.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {summary.kpis.map((k, i) => (
            <KpiChip key={`${k.label}-${i}`} kpi={k} />
          ))}
        </div>
      ) : null}

      {summary.summary_short ? (
        <p
          className={clsx(
            "mt-4 text-tx",
            compact ? "text-[13.5px] leading-[1.55]" : "text-[15px] leading-[1.5] font-medium",
          )}
        >
          {summary.summary_short}
        </p>
      ) : null}

      {!compact && summary.summary_long ? (
        <p className="mt-3 text-[13.5px] leading-[1.6] text-tx-mid">
          {summary.summary_long}
        </p>
      ) : null}

      {summary.confidence_notes && summary.confidence_notes.trim().length > 0 ? (
        <div
          role="note"
          className="mt-4 flex items-start gap-2 rounded-[8px] border border-[rgba(202,138,4,0.35)] bg-[rgba(202,138,4,0.08)] px-3 py-2 text-[12.5px] leading-[1.55] text-tx"
        >
          <AlertTriangle
            aria-hidden
            className="mt-[2px] h-[14px] w-[14px] shrink-0 text-[rgba(202,138,4,1)]"
          />
          <div>
            <span className="mr-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-[rgba(202,138,4,1)]">
              Confidence notes
            </span>
            <span className="text-tx-mid">{summary.confidence_notes}</span>
          </div>
        </div>
      ) : null}

      <footer className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-bd pt-3 text-[11.5px] text-tx3">
        <span className="font-mono uppercase tracking-[0.06em]">
          AI-generated
        </span>
        <span aria-hidden>·</span>
        <time dateTime={summary.generated_at}>{summary.generated_at}</time>
        <span aria-hidden>·</span>
        <a
          href={summary.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-tx underline decoration-bd underline-offset-2 hover:decoration-tx2"
        >
          Source
          <ArrowUpRight aria-hidden className="h-[12px] w-[12px]" />
        </a>
      </footer>
    </article>
  );
}

// One chip per KPI. Reuses the direction-colored semantics from
// SurprisePill (green up / red down / neutral flat), scoped to
// summary chips rather than beat/miss so the two never conflict
// visually on the same page.
function KpiChip({ kpi }: { kpi: import("@/lib/types").SummaryKpi }) {
  const cls = directionClass(kpi.direction);
  const Icon = directionIcon(kpi.direction);
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-[8px] border px-[9px] py-[5px] font-mono text-[12px]",
        cls,
      )}
    >
      <span className="text-tx-mid">{kpi.label}</span>
      <span className="font-semibold tabular-nums text-tx">{kpi.value}</span>
      {kpi.delta ? (
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Icon aria-hidden className="h-[11px] w-[11px]" />
          {kpi.delta}
          <span className="text-tx3">· {kpi.delta_basis}</span>
        </span>
      ) : null}
    </span>
  );
}

function directionClass(d: SummaryDirection): string {
  switch (d) {
    case "up":
      return "text-success-fg bg-[rgba(18,183,106,0.08)] border-[rgba(18,183,106,0.28)]";
    case "down":
      // Note: for cost-basis KPIs (C1, AISC), "down" is favourable.
      // The chip is red-tinted regardless — the /earnings command's
      // author controls direction semantics, not this component.
      return "text-danger bg-[rgba(180,35,24,0.06)] border-[rgba(180,35,24,0.28)]";
    case "flat":
      return "text-tx2 bg-s3 border-bd2";
    case "n/a":
    default:
      return "text-tx-mid bg-s2 border-bd";
  }
}

function directionIcon(d: SummaryDirection) {
  switch (d) {
    case "up":
      return ArrowUp;
    case "down":
      return ArrowDown;
    case "flat":
      return Minus;
    case "n/a":
    default:
      return Minus;
  }
}
