import clsx from "clsx";

export function SurprisePill({
  surprisePct,
  compact = false,
}: {
  surprisePct: number | null;
  compact?: boolean;
}) {
  if (surprisePct === null) {
    return (
      <span className="text-[12px] text-tx3">n/a — no estimate</span>
    );
  }
  const isBeat = surprisePct > 0.5;
  const isMiss = surprisePct < -0.5;
  const isInline = !isBeat && !isMiss;
  const cls = isBeat
    ? "text-[#4ade80] bg-[rgba(52,211,153,0.12)]"
    : isMiss
    ? "text-danger bg-[rgba(248,113,113,0.12)]"
    : "text-tx2 bg-s3";

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
        "inline-flex items-center rounded-[6px] px-[7px] py-[3px] font-mono text-[12px]",
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
