import clsx from "clsx";
import { ArrowUpRight, AlertTriangle, ArrowUp, ArrowDown, Minus } from "lucide-react";
import type { Summary, SummaryDirection, SummaryDriver, SummaryDriverBasis } from "@/lib/types";
import { OlderSummaries } from "./OlderSummaries";
import { RegenerateSummaryButton } from "./RegenerateSummaryButton";

// Compact summary panel. Design goals:
//   • Tight vertical rhythm — no wasted padding.
//   • Sharp hierarchy: eyebrow (tiny mono) → headline (sharp, 17px) →
//     KPI chips row → summary paragraphs → optional drivers + notes.
//   • Regenerate button lives in the header, secondary styling so it
//     doesn't compete with the headline.
//   • Card sits below the SecurityHeader and above OperatingDetail on
//     the ticker page.

function DepthBadge({ depth }: { depth: "filing" | "kpi-only" }) {
  const isFiling = depth === "filing";
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-[3px] border px-[5px] py-[1px] font-mono text-[9px] tracking-[0.06em] uppercase leading-[1.2]",
        isFiling
          ? "border-[rgba(18,183,106,0.32)] bg-[rgba(18,183,106,0.10)] text-success-fg"
          : "border-bd bg-s2 text-tx-mid",
      )}
      title={
        isFiling
          ? "Filing-based: primary release / 10-Q was read; drivers and guidance assessed."
          : "KPI-only: composed from verified shard metrics + deltas only. No filing was read; drivers and guidance not assessed."
      }
    >
      {isFiling ? "Filing" : "KPI-only"}
    </span>
  );
}

interface Props {
  summaries: Summary[]; // sorted latest-first
  latestReportedPeriod?: string | null;
  ticker?: string;
}

export function SummaryPanel({ summaries, latestReportedPeriod, ticker }: Props) {
  if (summaries.length === 0) return null;
  const latest = summaries[0];
  if (latestReportedPeriod && latest.period !== latestReportedPeriod) return null;

  const older = summaries.slice(1);
  return (
    <section className="mt-6" aria-labelledby="summary-panel-headline">
      <SummaryCard summary={latest} ticker={ticker} />
      {older.length > 0 ? <OlderSummaries summaries={older} /> : null}
    </section>
  );
}

export function SummaryCard({
  summary,
  compact = false,
  ticker,
}: {
  summary: Summary;
  compact?: boolean;
  ticker?: string;
}) {
  return (
    <article
      className={clsx(
        "rounded-[8px] border border-bd bg-panel",
        compact ? "px-4 py-3" : "px-5 py-4",
      )}
    >
      {/* Header: eyebrow row + regenerate button + headline */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.07em] text-tx3">
            <span>AI summary</span>
            <span aria-hidden>·</span>
            <span className="text-tx-mid">{summary.period}</span>
            <span aria-hidden>·</span>
            <span>reported {summary.reported_at}</span>
            <DepthBadge depth={summary.depth ?? "filing"} />
          </div>
          <h2
            id={compact ? undefined : "summary-panel-headline"}
            className="mt-[6px] text-[17px] font-semibold leading-[1.3] text-tx"
          >
            {summary.headline}
          </h2>
        </div>
        {!compact && ticker ? (
          <div className="shrink-0">
            <RegenerateSummaryButton ticker={ticker} />
          </div>
        ) : null}
      </header>

      {/* KPI chips — horizontal row, wraps under. */}
      {!compact && summary.kpis.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-[6px]">
          {summary.kpis.map((k, i) => (
            <KpiChip key={`${k.label}-${i}`} kpi={k} />
          ))}
        </div>
      ) : null}

      {/* Summary text — short is emphasized; long is smaller + muted. */}
      {summary.summary_short ? (
        <p
          className={clsx(
            "mt-3 text-tx",
            compact ? "text-[13px] leading-[1.5]" : "text-[14px] leading-[1.5]",
          )}
        >
          {summary.summary_short}
        </p>
      ) : null}

      {!compact && summary.summary_long ? (
        <p className="mt-2 text-[12.5px] leading-[1.6] text-tx-mid">
          {summary.summary_long}
        </p>
      ) : null}

      {/* Drivers section — only if present and not empty. */}
      {!compact && Array.isArray(summary.drivers) && summary.drivers.length > 0 ? (
        <DriversList drivers={summary.drivers} />
      ) : null}

      {/* Confidence notes — warning-tinted when populated. */}
      {summary.confidence_notes && summary.confidence_notes.trim().length > 0 ? (
        <div
          role="note"
          className="mt-3 flex items-start gap-2 rounded-[6px] border border-[rgba(202,138,4,0.32)] bg-[rgba(202,138,4,0.07)] px-2.5 py-1.5 text-[11.5px] leading-[1.5]"
        >
          <AlertTriangle
            aria-hidden
            className="mt-[2px] h-[12px] w-[12px] shrink-0 text-[rgba(202,138,4,1)]"
          />
          <div>
            <span className="mr-1 font-mono text-[9.5px] uppercase tracking-[0.06em] text-[rgba(202,138,4,1)]">
              Confidence
            </span>
            <span className="text-tx-mid">{summary.confidence_notes}</span>
          </div>
        </div>
      ) : null}

      {/* Footer — small, muted, one line. */}
      <footer className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-bd pt-2 font-mono text-[10.5px] text-tx3">
        <span className="uppercase tracking-[0.06em]">AI-generated</span>
        <span aria-hidden>·</span>
        <time dateTime={summary.generated_at}>{summary.generated_at}</time>
        <span aria-hidden>·</span>
        <a
          href={summary.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-tx-mid underline decoration-bd underline-offset-2 hover:text-tx hover:decoration-tx2"
        >
          Source
          <ArrowUpRight aria-hidden className="h-[10.5px] w-[10.5px]" />
        </a>
      </footer>
    </article>
  );
}

function KpiChip({ kpi }: { kpi: import("@/lib/types").SummaryKpi }) {
  const cls = directionClass(kpi.direction);
  const Icon = directionIcon(kpi.direction);
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-[6px] rounded-[6px] border px-[7px] py-[3px] font-mono text-[11px]",
        cls,
      )}
    >
      <span className="text-tx-mid">{kpi.label}</span>
      <span className="font-semibold tabular-nums text-tx">{kpi.value}</span>
      {kpi.delta ? (
        <span className="inline-flex items-center gap-[3px] tabular-nums">
          <Icon aria-hidden className="h-[10px] w-[10px]" />
          {kpi.delta}
          <span className="text-tx3">· {kpi.delta_basis}</span>
        </span>
      ) : null}
    </span>
  );
}

function DriversList({ drivers }: { drivers: SummaryDriver[] }) {
  return (
    <section
      aria-label="Why the numbers moved"
      className="mt-3 rounded-[6px] border border-bd bg-panel2/60"
    >
      <p className="border-b border-bd px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.07em] text-tx3">
        Why the numbers moved
      </p>
      <ul className="divide-y divide-bd">
        {drivers.map((d, i) => {
          const notExplained = /^not explained in the release$/i.test(d.explanation.trim());
          const Icon = directionIcon(d.direction);
          const dirClass =
            d.direction === "up"
              ? "text-success-fg"
              : d.direction === "down"
              ? "text-danger"
              : "text-tx-mid";
          return (
            <li
              key={`${d.metric}-${i}`}
              className={clsx(
                "flex items-start gap-2 px-2.5 py-1.5 text-[12px] leading-[1.5]",
                notExplained && "opacity-70",
              )}
            >
              <Icon aria-hidden className={clsx("mt-[3px] h-[11px] w-[11px] shrink-0", dirClass)} />
              <div className="min-w-[7rem] shrink-0 font-mono text-[10.5px] uppercase tracking-[0.04em] text-tx-mid">
                {d.metric}
              </div>
              <div className={clsx("flex-1", notExplained ? "text-tx3 italic" : "text-tx")}>
                {d.explanation}
              </div>
              <DriverBasisTag basis={d.basis} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DriverBasisTag({ basis }: { basis: SummaryDriverBasis }) {
  const isCompany = basis === "company-disclosed";
  return (
    <span
      title={
        isCompany
          ? "Cause is explicitly stated in the filing / MD&A"
          : "Cause is a mechanical decomposition of our own KPI data — arithmetic only, not speculation"
      }
      className={clsx(
        "ml-1.5 shrink-0 rounded-[3px] border px-[5px] py-[1px] font-mono text-[9px] uppercase tracking-[0.07em]",
        isCompany
          ? "border-bd bg-s2 text-tx-mid"
          : "border-[rgba(140,140,140,0.35)] bg-transparent text-tx3",
      )}
    >
      {isCompany ? "Company" : "Derived"}
    </span>
  );
}

function directionClass(d: SummaryDirection): string {
  switch (d) {
    case "up":
      return "text-success-fg bg-[rgba(18,183,106,0.08)] border-[rgba(18,183,106,0.28)]";
    case "down":
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
