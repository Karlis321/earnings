import clsx from "clsx";

export function SurprisePill({
  surprisePct,
  compact = false,
  // hasActual = true means the number IS reported, we just don't have
  // an estimate to compare against — a common case for foreign tickers
  // where Yahoo timeseries returned filings but no consensus was ever
  // published. Distinguish that from "no actual either" (a blank event).
  hasActual = null,
  // crossBasisCleared = true means we DID have both sides but they were
  // from incompatible sources (SEC GAAP EPS Basic actual vs Yahoo
  // consensus adjusted-EPS estimate). Rendering a cross-basis surprise
  // is worse than none — apples-to-oranges comparisons mislead more
  // than they inform. Show a specific label so the reader knows why
  // there's no number.
  crossBasisCleared = false,
  // Y/Y revenue growth fallback — when there's no clean surprise to
  // show, but we DO know how the reported quarter compares to the
  // same quarter last year, surface that as a labeled chip instead
  // of the generic 'reported · basis mismatch' / 'reported · no est'.
  // Universal signal that works for 84% of operating rows (Yahoo
  // doesn't publish revenue estimates but the actuals are on file).
  yoyRevGrowthPct = null,
}: {
  surprisePct: number | null;
  compact?: boolean;
  hasActual?: boolean | null;
  crossBasisCleared?: boolean;
  yoyRevGrowthPct?: number | null;
}) {
  // Y/Y revenue growth is now the PRIMARY chip when populated,
  // regardless of whether surprisePct exists. This makes the column
  // display a consistent metric across the whole grid — every row
  // shows the SAME comparison type (Y/Y rev growth) rather than a
  // mix of beat/miss %, Y/Y rev, basis-mismatch labels, and
  // no-est labels depending on data availability per row.
  //
  // Universe coverage: Y/Y revenue growth = 81.3% of operating rows.
  // Only 6.3% currently populate a same-basis EPS surprise (mostly
  // Korean/Chinese listings) — those get the Y/Y chip too. The
  // green/red beat/miss chip below is now a fallback for rows
  // without Y/Y coverage.
  if (yoyRevGrowthPct !== null && yoyRevGrowthPct !== undefined && Number.isFinite(yoyRevGrowthPct)) {
    // Color-code by direction: growth green, decline red, ~flat neutral.
    const isGrowth = yoyRevGrowthPct > 0.5;
    const isDecline = yoyRevGrowthPct < -0.5;
    const cls = isGrowth
      ? "text-success-fg bg-[rgba(18,183,106,0.10)] border-[rgba(18,183,106,0.28)]"
      : isDecline
      ? "text-danger bg-[rgba(180,35,24,0.08)] border-[rgba(180,35,24,0.28)]"
      : "text-tx2 bg-s3 border-bd2";
    const sign = yoyRevGrowthPct > 0 ? "+" : "";
    return (
      <span
        className={clsx(
          "inline-flex items-center rounded-[6px] border px-[7px] py-[3px] font-mono text-[12px] font-medium tabular-nums",
          cls,
        )}
        title={
          surprisePct !== null
            ? `Y/Y revenue growth on the latest reported quarter. (EPS surprise available: ${surprisePct > 0 ? "+" : ""}${surprisePct.toFixed(1)}%.)`
            : crossBasisCleared
              ? "Y/Y revenue growth on the latest reported quarter. EPS surprise cleared (GAAP actual vs adjusted-EPS consensus)."
              : "Y/Y revenue growth on the latest reported quarter."
        }
        aria-label={`Revenue ${isGrowth ? "grew" : isDecline ? "declined" : "was roughly flat"} ${Math.abs(yoyRevGrowthPct).toFixed(1)} percent year over year`}
      >
        {sign}{yoyRevGrowthPct.toFixed(1)}% y/y rev
      </span>
    );
  }
  if (surprisePct === null) {
    if (crossBasisCleared) {
      return (
        <span
          className="inline-flex items-center rounded-[6px] border border-bd bg-s2 px-[6px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-tx-mid"
          title="Actual (GAAP filing) and estimate (analyst-consensus, adjusted basis) come from different accounting bases. Cross-basis surprise% would mislead — suppressed."
        >
          reported · basis mismatch
        </span>
      );
    }
    // If we have an actual but no estimate — say so explicitly. Not
    // the same as "no data at all".
    if (hasActual === true) {
      return (
        <span
          className="inline-flex items-center rounded-[6px] border border-bd bg-s2 px-[6px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-tx-mid"
          title="Reported — no consensus estimate available for this ticker"
        >
          reported · no est
        </span>
      );
    }
    if (hasActual === false) {
      return <span className="text-[12px] text-tx3">not reported</span>;
    }
    // Legacy caller — surface generic "no estimate" the old way.
    return <span className="text-[12px] text-tx3">n/a — no estimate</span>;
  }
  const isBeat = surprisePct > 0.5;
  const isMiss = surprisePct < -0.5;
  const cls = isBeat
    ? "text-success-fg bg-[rgba(18,183,106,0.10)] border-[rgba(18,183,106,0.28)]"
    : isMiss
    ? "text-danger bg-[rgba(180,35,24,0.08)] border-[rgba(180,35,24,0.28)]"
    : "text-tx2 bg-s3 border-bd2";

  const label = compact
    ? `${surprisePct > 0 ? "+" : ""}${surprisePct.toFixed(1)}%`
    : isBeat
    ? `Beat ${surprisePct > 0 ? "+" : ""}${surprisePct.toFixed(1)}%`
    : isMiss
    ? `Miss ${surprisePct.toFixed(1)}%`
    : "Inline";

  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-[6px] border px-[7px] py-[3px] font-mono text-[12px] font-medium",
        cls,
      )}
      aria-label={
        isBeat
          ? `Beat estimates by ${surprisePct.toFixed(1)} percent`
          : isMiss
          ? `Missed estimates by ${Math.abs(surprisePct).toFixed(1)} percent`
          : "Inline with estimates"
      }
    >
      {label}
    </span>
  );
}
