// Compact ticker chip — no external logo images.
//
// Renders the base ticker symbol (part before the space) inside a rounded
// box. Falls back to the displayName's initials when the ticker is empty
// or all-punctuation. Same signature the callers already use so nothing
// needs to change downstream.

import { tickerInitials } from "@/lib/logos";
import clsx from "clsx";

interface Props {
  ticker: string;
  name: string;
  size?: number;
  className?: string;
}

function shortLabel(ticker: string, name: string): string {
  const base = ticker.split(/\s+/)[0]?.trim();
  if (base && base.length > 0 && base.length <= 6) return base.toUpperCase();
  return tickerInitials(name);
}

export function TickerLogo({ ticker, name, size = 32, className }: Props) {
  const label = shortLabel(ticker, name);
  // Font scales with the container so a 24px chip stays readable.
  const fontSize = Math.max(9, Math.round(size * (label.length >= 5 ? 0.32 : 0.42)));
  return (
    <span
      className={clsx(
        "inline-flex flex-none items-center justify-center rounded-[6px] border border-bd bg-s1 font-mono font-semibold tracking-[0.02em] text-tx2",
        className,
      )}
      style={{ width: size, height: size, fontSize }}
      aria-label={name}
      title={`${name} · ${ticker}`}
    >
      {label}
    </span>
  );
}
