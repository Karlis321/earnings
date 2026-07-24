import type { SecurityType } from "@/lib/types";
import clsx from "clsx";

const styles: Record<SecurityType, string> = {
  operating:
    "bg-[rgba(47,127,255,0.08)] border-[rgba(47,127,255,0.30)] text-brand-fg",
  developer:
    "bg-[rgba(105,65,198,0.08)] border-[rgba(105,65,198,0.28)] text-dev-fg",
  etf:
    "bg-[rgba(6,118,71,0.08)] border-[rgba(6,118,71,0.28)] text-etf-fg",
};

const labels: Record<SecurityType, string> = {
  operating: "Operating",
  developer: "Developer",
  etf: "ETF",
};

export function TypeBadge({
  type,
  size = "md",
}: {
  type: SecurityType;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-[6px] border font-medium",
        styles[type],
        size === "sm"
          ? "h-5 px-[7px] text-[9.5px] font-mono uppercase"
          : "h-6 px-[10px] text-[11.5px]",
      )}
      aria-label={`Security type: ${labels[type]}`}
    >
      {size === "sm" ? labels[type].toUpperCase() : labels[type]}
    </span>
  );
}
