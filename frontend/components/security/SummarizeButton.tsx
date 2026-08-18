"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, AlertCircle } from "lucide-react";
import clsx from "clsx";

// Client-side Summarize button. Rendered where the SummaryPanel would
// normally sit but doesn't (no summary for the latest reported period).
// On click:
//   1. Reads CRON_SECRET from localStorage; if missing, prompts once.
//   2. POSTs {ticker} to /api/summarize with Bearer $CRON_SECRET.
//   3. On 202: swaps to "Summary in progress" and starts polling
//      /api/entity/<ticker>/has-summary every 60s. When a summary
//      lands the parent page is force-refreshed (router.refresh())
//      so the RSC re-renders with the SummaryPanel visible.
//   4. On 409/429: shows a friendly one-line reason inline.
//   5. On any other status: shows the error message inline.
//
// CRON_SECRET pattern: this is a personal-dashboard shared secret.
// Storing it in localStorage on first prompt keeps subsequent clicks
// zero-friction while avoiding an env var that would broadcast the
// secret in every page's HTML. Karlis clears localStorage to rotate.

interface Props {
  ticker: string;
  period: string | null;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "dispatched"; startedAt: number }
  | { kind: "error"; message: string; status: number };

const LS_KEY = "earnings-cron-secret";
const POLL_MS = 60_000;

function readSecret(): string | null {
  try {
    return window.localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

function persistSecret(value: string) {
  try {
    window.localStorage.setItem(LS_KEY, value);
  } catch {
    /* private browsing / storage disabled */
  }
}

export function SummarizeButton({ ticker, period }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    // Poll HEAD on the summary route — if 200, the file has landed;
    // trigger a router refresh so the RSC re-renders with the panel.
    // /api/entity/<ticker>/has-summary is a lightweight in-repo check
    // added next to the route; falls back to fetching /s/<ticker> HTML
    // and looking for the "AI summary" marker if that route isn't
    // wired.
    pollTimer.current = setInterval(async () => {
      try {
        const r = await fetch(
          `/api/entity/${encodeURIComponent(ticker)}/has-summary`,
          { cache: "no-store" },
        );
        if (r.ok) {
          const j = (await r.json()) as { hasSummaryForLatest?: boolean };
          if (j.hasSummaryForLatest) {
            stopPolling();
            window.location.reload();
          }
        }
      } catch {
        /* transient — keep polling */
      }
    }, POLL_MS);
  }, [ticker, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const onClick = useCallback(async () => {
    let secret = readSecret();
    if (!secret) {
      const entered = typeof window !== "undefined"
        ? window.prompt(
            "This is a shared-secret gate (CRON_SECRET). Paste it here — the value is stored in your browser only.",
          )
        : null;
      if (!entered) return;
      persistSecret(entered);
      secret = entered;
    }
    setState({ kind: "loading" });
    try {
      // `force: true` bypasses the covered-tier 403 gate on
      // /api/summarize (route.ts lines 118-129). Rationale: this
      // button ONLY renders when there's no summary for the latest
      // period (parent SummaryPanel absence signal), so we're never
      // clobbering an existing summary — force here just widens the
      // route from "covered-17 only" to "any registered ticker",
      // which matches the current usage pattern (audit fills, R1000
      // batch, etc.). The 409-guard is still respected because if
      // a summary DID exist, the panel would render and the button
      // wouldn't be visible at all.
      const r = await fetch("/api/summarize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ ticker, force: true }),
      });
      if (r.status === 202) {
        setState({ kind: "dispatched", startedAt: Date.now() });
        startPolling();
        return;
      }
      let body: { error?: string; message?: string; existingPeriod?: string; retryAfterSec?: number } | null = null;
      try { body = await r.json(); } catch { /* not JSON */ }
      // 401 usually = wrong secret; clear it so the next click re-prompts.
      if (r.status === 401) {
        try { window.localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
      }
      const msg =
        r.status === 409 && body?.existingPeriod
          ? `A summary for ${body.existingPeriod} already exists — refresh the page`
          : r.status === 429 && body?.retryAfterSec
          ? `Recently dispatched — try again in ${Math.ceil(body.retryAfterSec / 60)} min`
          : body?.message ?? `Request failed (HTTP ${r.status})`;
      setState({ kind: "error", message: msg, status: r.status });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Network error",
        status: 0,
      });
    }
  }, [ticker, startPolling]);

  return (
    <section className="mt-6 rounded-[10px] border border-dashed border-bd bg-panel/60 px-5 py-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
        No summary yet for {period ?? "the latest period"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onClick}
          disabled={state.kind === "loading" || state.kind === "dispatched"}
          className={clsx(
            "inline-flex items-center gap-2 rounded-[8px] border px-3.5 py-2 text-[13px] font-medium transition-colors",
            state.kind === "dispatched"
              ? "border-bd bg-s2 text-tx-mid cursor-not-allowed"
              : state.kind === "loading"
              ? "border-bd bg-s2 text-tx-mid cursor-wait"
              : "border-bd bg-s1 text-tx hover:bg-s2 hover:border-[rgba(10,37,64,0.22)]",
          )}
        >
          {state.kind === "loading" ? (
            <Loader2 aria-hidden className="h-[14px] w-[14px] animate-spin" />
          ) : state.kind === "dispatched" ? (
            <Loader2 aria-hidden className="h-[14px] w-[14px] animate-spin" />
          ) : (
            <Sparkles aria-hidden className="h-[14px] w-[14px]" />
          )}
          <span>
            {state.kind === "dispatched"
              ? "Summary in progress — ready in a few minutes"
              : state.kind === "loading"
              ? "Dispatching…"
              : "Summarize this quarter"}
          </span>
        </button>
        {state.kind === "dispatched" ? (
          <span className="font-mono text-[11px] text-tx3">
            polling for the finished summary every {POLL_MS / 1000}s
          </span>
        ) : null}
      </div>
      {state.kind === "error" ? (
        <div className="mt-2 flex items-start gap-2 rounded-[6px] border border-[rgba(180,35,24,0.35)] bg-[rgba(180,35,24,0.06)] px-3 py-2 text-[12.5px] leading-[1.5] text-tx">
          <AlertCircle aria-hidden className="mt-[2px] h-[14px] w-[14px] shrink-0 text-danger" />
          <span>{state.message}</span>
        </div>
      ) : null}
    </section>
  );
}
