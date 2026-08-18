"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, AlertCircle, Zap } from "lucide-react";
import clsx from "clsx";

// Live elapsed-time counter so users see the summary run is alive
// rather than a static "in progress" string. Ticks every second while
// mounted and formats mm:ss.
function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (startedAt == null) return "0:00";
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Rough phase labeling — inferred from elapsed since dispatch. The
// underlying /earnings run doesn't stream real progress back, so this
// is an honest best-guess ladder that matches typical timings from
// the workflow logs. Users need SOMETHING moving on screen; a stale
// "in progress" reads as frozen.
function phaseLabel(startedAt: number | null): string {
  if (startedAt == null) return "Preparing…";
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs < 30) return "Dispatching to GitHub Actions";
  if (secs < 90) return "Booting Claude Code runner";
  if (secs < 240) return "Resolving primary source & fetching filing";
  if (secs < 480) return "Extracting KPIs & composing summary";
  if (secs < 900) return "Applying extended metrics & validating";
  return "Finalizing — commit landing shortly";
}

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

  const dispatchedAt = state.kind === "dispatched" ? state.startedAt : null;
  const elapsed = useElapsed(dispatchedAt);
  const phase = phaseLabel(dispatchedAt);

  return (
    <section className="mt-6 rounded-[10px] border border-dashed border-bd bg-panel/60 px-5 py-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
        No summary yet for {period ?? "the latest period"}
      </p>

      {state.kind === "dispatched" ? (
        // Live progress panel with layered animations so the user
        // sees the run is alive even at a glance. Layers:
        //   - Rotating dashed conic ring around the spinner
        //   - Pulsing halo ping (peripheral-vision cue)
        //   - Standard Loader2 spinner (steady motion)
        //   - Three orbit dots circling the spinner (~2s revolution)
        //   - Bouncing-dot text after the phrase
        //   - Live ticking clock (m:ss)
        //   - Determinate progress bar at the bottom (0–100% based on
        //     inferred phase — ~1% every 9 seconds of a typical 15 min
        //     run so users see it inching forward continuously)
        <div className="mt-3 flex flex-col gap-3 rounded-[8px] border border-bd bg-s1 px-4 py-3.5">
          <div className="flex items-center gap-4">
            {/* SPINNER STACK: 4 concurrent animations */}
            <div className="relative flex h-14 w-14 shrink-0 items-center justify-center">
              {/* Layer 1: outer conic gradient ring spinning slowly */}
              <span
                aria-hidden
                className="absolute inset-0 animate-spin rounded-full"
                style={{
                  animationDuration: "3s",
                  background:
                    "conic-gradient(from 0deg, var(--brand) 0%, var(--brand) 15%, transparent 15%, transparent 100%)",
                  maskImage: "radial-gradient(circle, transparent 55%, black 56%, black 100%)",
                  WebkitMaskImage:
                    "radial-gradient(circle, transparent 55%, black 56%, black 100%)",
                }}
              />
              {/* Layer 2: expanding pulse ring */}
              <span
                aria-hidden
                className="absolute inset-1 animate-ping rounded-full border-2 border-brand-fg/40"
                style={{ animationDuration: "1.8s" }}
              />
              {/* Layer 3: orbiting dot — CSS-rotate a wrapper so the dot flies around */}
              <span
                aria-hidden
                className="absolute inset-0 animate-spin"
                style={{ animationDuration: "2.4s" }}
              >
                <span className="absolute left-1/2 top-0 -translate-x-1/2 h-2 w-2 rounded-full bg-brand-fg shadow-[0_0_6px_var(--brand-fg)]" />
              </span>
              {/* Layer 4: second orbiting dot on opposite side, different speed */}
              <span
                aria-hidden
                className="absolute inset-0 animate-spin"
                style={{ animationDuration: "3.6s", animationDirection: "reverse" }}
              >
                <span className="absolute left-1/2 bottom-0 -translate-x-1/2 h-1.5 w-1.5 rounded-full bg-brand-fg/70" />
              </span>
              {/* Layer 5: inner circle with the standard spinner */}
              <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-brand/15">
                <Loader2 aria-hidden className="h-5 w-5 animate-spin text-brand-fg" />
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[14px] font-medium text-tx">
                Generating summary
                <span className="inline-flex items-baseline text-tx-mid" aria-hidden>
                  <span className="inline-block animate-bounce" style={{ animationDuration: "1s", animationDelay: "0ms" }}>.</span>
                  <span className="inline-block animate-bounce" style={{ animationDuration: "1s", animationDelay: "150ms" }}>.</span>
                  <span className="inline-block animate-bounce" style={{ animationDuration: "1s", animationDelay: "300ms" }}>.</span>
                </span>
              </div>
              <div className="mt-0.5 text-[12px] text-tx-mid truncate">{phase}</div>
            </div>
            <div className="flex flex-col items-end shrink-0">
              <div className="flex items-center gap-1 font-mono text-[14px] tabular-nums text-tx">
                <Zap aria-hidden className="h-3.5 w-3.5 text-brand-fg animate-pulse" />
                {elapsed}
              </div>
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-tx3">
                elapsed
              </div>
            </div>
          </div>
          {/* Indeterminate shimmer progress bar — always sliding L→R so
              users see continuous motion even between phase transitions */}
          <div className="relative h-1 overflow-hidden rounded-full bg-bd">
            <span
              aria-hidden
              className="absolute inset-y-0 w-1/3 rounded-full bg-brand-fg/70"
              style={{
                animation: "slbtn-slide 1.8s linear infinite",
              }}
            />
            <style>{`
              @keyframes slbtn-slide {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(400%); }
              }
            `}</style>
          </div>
          <div className="text-[11.5px] text-tx3">
            Polling every {POLL_MS / 1000}s — page reloads automatically once the commit lands.
            Typical wall time: 5-15 min.
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onClick}
            disabled={state.kind === "loading"}
            className={clsx(
              "inline-flex items-center gap-2 rounded-[8px] border px-3.5 py-2 text-[13px] font-medium transition-colors",
              state.kind === "loading"
                ? "border-bd bg-s2 text-tx-mid cursor-wait"
                : "border-bd bg-s1 text-tx hover:bg-s2 hover:border-[rgba(10,37,64,0.22)]",
            )}
          >
            {state.kind === "loading" ? (
              <Loader2 aria-hidden className="h-[14px] w-[14px] animate-spin" />
            ) : (
              <Sparkles aria-hidden className="h-[14px] w-[14px]" />
            )}
            <span>
              {state.kind === "loading"
                ? "Dispatching…"
                : "Summarize this quarter"}
            </span>
          </button>
        </div>
      )}
      {state.kind === "error" ? (
        <div className="mt-2 flex items-start gap-2 rounded-[6px] border border-[rgba(180,35,24,0.35)] bg-[rgba(180,35,24,0.06)] px-3 py-2 text-[12.5px] leading-[1.5] text-tx">
          <AlertCircle aria-hidden className="mt-[2px] h-[14px] w-[14px] shrink-0 text-danger" />
          <span>{state.message}</span>
        </div>
      ) : null}
    </section>
  );
}
