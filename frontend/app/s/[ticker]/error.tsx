"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

// Route-level error boundary for /s/[ticker]. Same diagnostic-bundle
// pattern as the event page error boundary — copyable stack + ticker
// context so a screenshot-only report is still actionable.
export default function TickerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ ticker?: string }>();
  const rawTicker = params?.ticker;
  const ticker = rawTicker ? decodeURIComponent(rawTicker) : "(unknown)";
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    console.error("[/s/[ticker] error boundary]", {
      message: error?.message ?? null,
      name: error?.name ?? null,
      digest: error?.digest ?? null,
      stack: error?.stack ?? null,
      ticker,
      url: typeof window !== "undefined" ? window.location.href : null,
    });
  }, [error, ticker]);

  const digestLine = error.digest ? `digest: ${error.digest}` : "digest: (none captured)";
  const stackLine =
    typeof error.stack === "string" && error.stack.length > 0
      ? error.stack
      : "(stack empty — likely a server-render throw before capture, check Vercel Runtime Logs for digest " +
        (error.digest ?? "?") +
        ")";

  const copyBundle = [
    `URL: /s/${ticker}`,
    `Ticker: ${ticker}`,
    `Error: ${error.name ?? "Error"}: ${error.message ?? "(no message)"}`,
    digestLine,
    "---",
    stackLine,
  ].join("\n");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyBundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* no-op */
    }
  };

  return (
    <div className="mx-auto max-w-[900px] px-10 py-8">
      <div className="rounded-panel border border-warning bg-[rgba(251,191,36,0.05)] p-6">
        <div className="mb-3 mono-eyebrow text-warning">
          Ticker page render error · diagnostic banner
        </div>
        <h1 className="mb-4 text-[22px] font-semibold text-tx">
          {error.name ?? "Error"}: {error.message ?? "(no message)"}
        </h1>
        <div className="mb-4 grid grid-cols-2 gap-2 font-mono text-[11.5px] text-tx-mid">
          <div>
            ticker · <span className="text-tx">{ticker}</span>
          </div>
          <div>
            digest · <span className="text-tx">{error.digest ?? "(none)"}</span>
          </div>
        </div>
        <details className="mt-4" open>
          <summary className="cursor-pointer text-[13px] text-brand-hi hover:text-brand-fg">
            Full stack trace
          </summary>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-[6px] border border-bd bg-panel p-4 font-mono text-[11px] text-tx-mid">
{stackLine}
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
          <button
            type="button"
            onClick={onCopy}
            className="rounded-[6px] border border-bd px-3 py-1.5 text-tx hover:bg-hover"
          >
            {copied ? "Copied ✓" : "Copy report bundle"}
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
