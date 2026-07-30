"use client";

import { Loader2 } from "lucide-react";

// Full-page loading spinner. Used by Next.js route-segment loading.tsx
// files (rendered automatically while the server-component data is
// resolving) and by any client component that wants the same visual
// vocabulary. Keeps the app's loading UX identical everywhere.

interface Props {
  label?: string;
  size?: "sm" | "md" | "lg";
  fullPage?: boolean;
}

export function LoadingSpinner({
  label = "Loading…",
  size = "md",
  fullPage = false,
}: Props) {
  const iconSize = size === "sm" ? 14 : size === "lg" ? 28 : 20;
  const textSize = size === "sm" ? "text-[12px]" : size === "lg" ? "text-[15px]" : "text-[13.5px]";
  const gap = size === "sm" ? "gap-2" : "gap-3";
  const wrapper = fullPage
    ? "mx-auto flex min-h-[420px] max-w-[1800px] items-center justify-center px-10 py-8"
    : "flex items-center justify-center";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${wrapper} ${textSize} ${gap} text-tx-mid`}
    >
      <Loader2
        size={iconSize}
        aria-hidden
        className="animate-spin text-brand-hi"
      />
      <span className="font-mono uppercase tracking-[0.06em]">{label}</span>
    </div>
  );
}
