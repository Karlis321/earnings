"use client";

// Regenerate an existing summary. Mirrors SummarizeButton's dispatch
// flow but sends `force: true` so /api/summarize bypasses the 409
// "already exists" gate and /earnings overwrites the current file.
//
// Sits inline in the summary card header — small, secondary styling
// so it doesn't compete with the headline.

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw, Loader2, AlertCircle } from "lucide-react";
import clsx from "clsx";

interface Props {
  ticker: string;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "dispatched" }
  | { kind: "error"; message: string };

const LS_KEY = "earnings-cron-secret";
const POLL_MS = 60_000;

function readSecret(): string | null {
  try { return window.localStorage.getItem(LS_KEY); } catch { return null; }
}
function persistSecret(v: string) {
  try { window.localStorage.setItem(LS_KEY, v); } catch { /* ignore */ }
}

export function RegenerateSummaryButton({ ticker }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef<number | null>(null);

  useEffect(() => () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
  }, []);

  const onClick = useCallback(async () => {
    // Confirm — overwriting is destructive of the current text.
    const ok = typeof window !== "undefined" &&
      window.confirm(
        `Regenerate the summary for ${ticker}? The current summary will be overwritten with a fresh read of the latest filing.`,
      );
    if (!ok) return;

    let secret = readSecret();
    if (!secret) {
      const entered = typeof window !== "undefined"
        ? window.prompt(
            "This is a shared-secret gate (CRON_SECRET). Paste it here — stored in your browser only.",
          )
        : null;
      if (!entered) return;
      persistSecret(entered);
      secret = entered;
    }
    setState({ kind: "loading" });
    try {
      const r = await fetch("/api/summarize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ ticker, force: true }),
      });
      if (r.status === 202) {
        startedAt.current = Date.now();
        setState({ kind: "dispatched" });
        // Poll the has-summary endpoint. When the file changes on
        // disk (new generated_at timestamp), reload the page.
        pollTimer.current = setInterval(async () => {
          // Simpler: after 3 min force a reload — the summary file
          // will have been rewritten and the UI needs to re-fetch.
          if (startedAt.current && Date.now() - startedAt.current > 180_000) {
            if (pollTimer.current) clearInterval(pollTimer.current);
            window.location.reload();
          }
        }, POLL_MS);
        return;
      }
      let body: { message?: string } | null = null;
      try { body = await r.json(); } catch { /* not JSON */ }
      if (r.status === 401) {
        try { window.localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
      }
      setState({ kind: "error", message: body?.message ?? `HTTP ${r.status}` });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Network error",
      });
    }
  }, [ticker]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={state.kind === "loading" || state.kind === "dispatched"}
        title="Regenerate this summary from a fresh read of the filing"
        className={clsx(
          "inline-flex items-center gap-[6px] rounded-[6px] border px-[9px] py-[4px] font-mono text-[10.5px] uppercase tracking-[0.06em] transition-colors",
          state.kind === "dispatched"
            ? "border-bd bg-s2 text-tx-mid cursor-not-allowed"
            : state.kind === "loading"
            ? "border-bd bg-s2 text-tx-mid cursor-wait"
            : "border-bd bg-transparent text-tx-mid hover:border-[rgba(10,37,64,0.28)] hover:bg-s1 hover:text-tx",
        )}
      >
        {state.kind === "loading" || state.kind === "dispatched" ? (
          <Loader2 aria-hidden className="h-[10.5px] w-[10.5px] animate-spin" />
        ) : (
          <RotateCw aria-hidden className="h-[10.5px] w-[10.5px]" />
        )}
        <span>
          {state.kind === "dispatched"
            ? "Regenerating…"
            : state.kind === "loading"
            ? "Dispatching…"
            : "Regenerate"}
        </span>
      </button>
      {state.kind === "error" ? (
        <span
          title={state.message}
          className="inline-flex items-center gap-1 text-[10.5px] text-danger"
        >
          <AlertCircle aria-hidden className="h-[11px] w-[11px]" />
          <span className="truncate max-w-[200px]">{state.message}</span>
        </span>
      ) : null}
    </div>
  );
}
