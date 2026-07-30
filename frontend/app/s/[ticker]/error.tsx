"use client";

import { useEffect } from "react";
import Link from "next/link";

// Route-level error boundary for /s/[ticker]. Catches any thrown
// error during SSR or client render, displays the full stack + digest
// so we can diagnose 500s in production without spelunking Vercel
// logs. Once the cause is fixed this can go — it's a diagnostic net,
// not a permanent UX pattern.
export default function TickerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[/s/[ticker] error boundary]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-[900px] px-10 py-8">
      <div className="rounded-panel border border-warning bg-[rgba(251,191,36,0.05)] p-6">
        <div className="mb-3 mono-eyebrow text-warning">
          Ticker page render error · diagnostic banner
        </div>
        <h1 className="mb-4 text-[22px] font-semibold text-tx">
          {error.name ?? "Error"}: {error.message ?? "unknown"}
        </h1>
        {error.digest ? (
          <div className="mb-3 font-mono text-[11.5px] text-tx-mid">
            digest · <span className="text-tx">{error.digest}</span>
          </div>
        ) : null}
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] text-brand-hi hover:text-brand-fg">
            Full stack trace
          </summary>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-[6px] border border-bd bg-panel p-4 font-mono text-[11px] text-tx-mid">
{error.stack ?? "(no stack captured)"}
          </pre>
        </details>
        <div className="mt-6 flex flex-wrap items-center gap-3 text-[13px]">
          <button
            type="button"
            onClick={reset}
            className="rounded-[6px] border border-bd px-3 py-1.5 text-tx hover:bg-hover"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-[6px] border border-bd px-3 py-1.5 text-tx hover:bg-hover"
          >
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
