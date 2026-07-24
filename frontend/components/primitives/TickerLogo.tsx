"use client";

import { useState } from "react";
import { logoUrl, tickerInitials } from "@/lib/logos";
import clsx from "clsx";

interface Props {
  ticker: string;
  name: string;
  size?: number;
  className?: string;
}

export function TickerLogo({ ticker, name, size = 32, className }: Props) {
  const src = logoUrl(ticker, size * 2); // 2x for retina
  const [errored, setErrored] = useState(false);
  const showFallback = !src || errored;

  return (
    <span
      className={clsx(
        "inline-flex flex-none items-center justify-center overflow-hidden rounded-[6px] border border-bd bg-s1",
        className,
      )}
      style={{ width: size, height: size }}
      aria-label={name}
      title={name}
    >
      {showFallback ? (
        <span
          className="font-semibold text-tx2"
          style={{ fontSize: Math.round(size * 0.42) }}
        >
          {tickerInitials(name)}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src!}
          alt={name}
          width={size}
          height={size}
          onError={() => setErrored(true)}
          className="h-full w-full object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
    </span>
  );
}
