import clsx from "clsx";
import { ArrowUpRight, AlertTriangle, ArrowUp, ArrowDown, Minus } from "lucide-react";
import type { Summary, SummaryDirection, SummaryDriver, SummaryDriverBasis } from "@/lib/types";
import { OlderSummaries } from "./OlderSummaries";
import { RegenerateSummaryButton } from "./RegenerateSummaryButton";

// Restructured summary card. Layout goals (from prompt1.txt):
//   1. Meta line (muted): "AI summary · <period> · reported <date> · Filing/KPI-only" + Regenerate button right-aligned.
//   2. Headline: one bold line, 17px.
//   3. Summary prose: 3-5 sentences, comfortable line-height, max-width ~70ch.
//   4. Capital returns strip: compact muted line with · separators (buybacks · dividends · declared dividend). Omit if empty.
//   5. KPI grid: each metric its own cell — name muted, value prominent, delta colored + separated.
//   6. "Why the numbers moved": collapsible via <details>, collapsed by default.
//   7. Caveats: warning-tinted (⚠), max 3 one-liners of user-facing content.
//   8. Pipeline notes: <details> disclosure, collapsed by default, monospace small text. Never visible on first paint.
//   9. Footer (tiny, muted): "AI-generated · timestamp · Source link".
// Mobile: KPI grid wraps to 2 columns via responsive grid.

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

// Heuristic split of confidence_notes into user-facing caveats vs
// pipeline-debug provenance. TODO: eventually make these separate
// fields on the Summary type and stop guessing. Current rules:
//   - Sentences containing script names (*.mjs), filenames (*.htm),
//     or workflow-jargon keywords ("REGENERATED", "prior version",
//     "downgraded", "backfill", etc.) → pipeline notes.
//   - Everything else → caveats. Capped at 3 caveats to keep the
//     warning box scannable.
function splitConfidenceNotes(raw: string | undefined | null): {
  caveats: string[];
  pipeline: string;
} {
  if (!raw || !raw.trim()) return { caveats: [], pipeline: "" };
  // Split on sentence boundaries. Semicolons kept inside sentences.
  const sentences = raw
    .split(/(?<=[.!?])\s+(?=[A-Z(⚠"])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pipelineRe =
    /\b(REGENERATED|regenerat(ed|ion)|prior kpi-only|prior version|downgrad(e|ed)|exhibit-|8-K cover|EX-99|backfill|ingest pipeline|force-regenerate|scripts\/|resolve-edgar|apply-extended|shard|Yahoo timeseries|SEC-verbatim|CIK|primary filing unreachable|kpi-only version)\b|\.(mjs|htm|json)/i;
  const caveats: string[] = [];
  const pipelineParts: string[] = [];
  for (const s of sentences) {
    if (pipelineRe.test(s)) pipelineParts.push(s);
    else caveats.push(s);
  }
  return { caveats: caveats.slice(0, 3), pipeline: pipelineParts.join(" ") };
}

// Extract capital-returns strip from summary_long if present. Looks for
// buyback / dividend paid / declared-dividend patterns. Returns null
// when nothing matches — strip is then omitted. TODO: promote to first-
// class fields on the Summary type once /earnings prompt tracks them.
function extractCapitalReturns(long: string | undefined | null): {
  buyback?: string;
  dividendPaid?: string;
  declaredDividend?: string;
} | null {
  if (!long) return null;
  const out: { buyback?: string; dividendPaid?: string; declaredDividend?: string } = {};
  const buy = long.match(/\$[\d.,]+[BM]?\s+in\s+buybacks?/i) ||
    long.match(/buybacks?\s+of\s+\$[\d.,]+[BM]?/i);
  if (buy) out.buyback = buy[0];
  const divPaid = long.match(/\$[\d.,]+[BM]?\s+in\s+dividends\s+paid/i) ||
    long.match(/dividends?\s+of\s+\$[\d.,]+[BM]?/i);
  if (divPaid) out.dividendPaid = divPaid[0];
  const declared = long.match(/\$[\d.]+\s*\/\s*share\s+(?:cash\s+)?dividend[^.]*(?:payable[^.]*|record[^.]*)?/i);
  if (declared) out.declaredDividend = declared[0].replace(/\s+/g, " ").trim();
  return Object.keys(out).length > 0 ? out : null;
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
  const { caveats, pipeline } = splitConfidenceNotes(summary.confidence_notes);
  const capReturns = compact ? null : extractCapitalReturns(summary.summary_long);
  const drivers = Array.isArray(summary.drivers) ? summary.drivers : [];

  return (
    <article
      className={clsx(
        "rounded-[8px] border border-bd bg-panel",
        compact ? "px-4 py-3" : "px-5 py-4",
      )}
    >
      {/* 1. Meta line + regenerate button */}
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
          {/* 2. Headline */}
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

      {/* 3. Summary prose — max-width 70ch, comfortable line-height. */}
      {summary.summary_short ? (
        <p
          className={clsx(
            "mt-3 text-tx",
            compact ? "text-[13px] leading-[1.55]" : "text-[14px] leading-[1.6] max-w-[70ch]",
          )}
        >
          {summary.summary_short}
        </p>
      ) : null}
      {!compact && summary.summary_long ? (
        <p className="mt-2 text-[13px] leading-[1.6] text-tx-mid max-w-[70ch]">
          {summary.summary_long}
        </p>
      ) : null}

      {/* 4. Capital returns strip — compact muted line. Omit if empty. */}
      {capReturns ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-tx3">
          <span>Capital returns</span>
          {capReturns.buyback ? (
            <>
              <span aria-hidden>·</span>
              <span className="normal-case tracking-normal text-tx-mid">{capReturns.buyback}</span>
            </>
          ) : null}
          {capReturns.dividendPaid ? (
            <>
              <span aria-hidden>·</span>
              <span className="normal-case tracking-normal text-tx-mid">{capReturns.dividendPaid}</span>
            </>
          ) : null}
          {capReturns.declaredDividend ? (
            <>
              <span aria-hidden>·</span>
              <span className="normal-case tracking-normal text-tx-mid">{capReturns.declaredDividend}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {/* 5. KPI grid — each metric its own cell. */}
      {!compact && summary.kpis.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 md:grid-cols-4">
          {summary.kpis.map((k, i) => (
            <KpiCell key={`${k.label}-${i}`} kpi={k} />
          ))}
        </div>
      ) : null}

      {/* 6. "Why the numbers moved" — collapsible, collapsed by default. */}
      {!compact && drivers.length > 0 ? (
        <details className="group mt-4 rounded-[6px] border border-bd bg-panel2/60">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-tx-mid hover:text-tx">
            <span>Why the numbers moved ({drivers.length})</span>
            <span
              aria-hidden
              className="text-tx3 transition-transform group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <DriversList drivers={drivers} />
        </details>
      ) : null}

      {/* 7. Caveats — warning-tinted, max 3 one-liners. */}
      {caveats.length > 0 ? (
        <div
          role="note"
          className="mt-3 flex items-start gap-2 rounded-[6px] border border-[rgba(202,138,4,0.32)] bg-[rgba(202,138,4,0.07)] px-2.5 py-1.5 text-[11.5px] leading-[1.5]"
        >
          <AlertTriangle
            aria-hidden
            className="mt-[2px] h-[12px] w-[12px] shrink-0 text-[rgba(202,138,4,1)]"
          />
          <ul className="min-w-0 flex-1 space-y-0.5 text-tx-mid">
            {caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 8. Pipeline notes — hidden by default, monospace small. */}
      {pipeline ? (
        <details className="mt-3 rounded-[6px] border border-bd bg-panel2/40">
          <summary className="cursor-pointer list-none px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.07em] text-tx3 hover:text-tx-mid">
            Pipeline notes
          </summary>
          <p className="px-2.5 py-1.5 font-mono text-[10.5px] leading-[1.5] text-tx3">
            {pipeline}
          </p>
        </details>
      ) : null}

      {/* 9. Footer — tiny, muted. */}
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

function KpiCell({ kpi }: { kpi: import("@/lib/types").SummaryKpi }) {
  const dirClass = kpi.direction === "up"
    ? "text-success-fg"
    : kpi.direction === "down"
    ? "text-danger"
    : "text-tx-mid";
  const Icon = directionIcon(kpi.direction);
  return (
    <div className="min-w-0 rounded-[6px] border border-bd bg-panel2/50 px-2.5 py-1.5">
      <div className="truncate font-mono text-[10px] uppercase tracking-[0.05em] text-tx3">
        {kpi.label}
      </div>
      <div className="mt-[2px] flex items-baseline gap-2">
        <span className="text-[14px] font-semibold tabular-nums text-tx">{kpi.value}</span>
        {kpi.delta ? (
          <span className={clsx("inline-flex items-center gap-[3px] text-[11px] tabular-nums", dirClass)}>
            <Icon aria-hidden className="h-[10px] w-[10px]" />
            {kpi.delta}
          </span>
        ) : null}
      </div>
      {kpi.delta && kpi.delta_basis ? (
        <div className="mt-[1px] font-mono text-[9px] uppercase tracking-[0.05em] text-tx3">
          {kpi.delta_basis}
        </div>
      ) : null}
    </div>
  );
}

function DriversList({ drivers }: { drivers: SummaryDriver[] }) {
  return (
    <ul className="divide-y divide-bd border-t border-bd">
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
