import clsx from "clsx";

export function SurprisePill({
  surprisePct,
  compact = false,
}: {
  surprisePct: number | null;
  compact?: boolean;
}) {
  if (surprisePct === null) {
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
