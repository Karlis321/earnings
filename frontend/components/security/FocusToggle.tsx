"use client";

// One-click add-to-focus / remove-from-focus button on /s/[ticker].
// Server pre-computes whether the ticker is currently in
// preferences.focusTickers and passes it as initialInFocus so the
// first paint is correct. On click, PUTs a full shared-state
// envelope with the mutated focusTickers[] back to the API.

import { useState, useTransition } from "react";
import { Star, StarOff } from "lucide-react";
import clsx from "clsx";
import type { SharedState } from "@/lib/types";

interface Props {
  ticker: string;
  initialInFocus: boolean;
  // Full shared-state snapshot from the server so we can PUT it
  // back with only focusTickers mutated (avoids losing customSources
  // / themes / other fields under concurrent edits from /settings).
  initialState: SharedState;
}

export function FocusToggle({ ticker, initialInFocus, initialState }: Props) {
  const [inFocus, setInFocus] = useState(initialInFocus);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setError(null);
    const nextInFocus = !inFocus;
    // Optimistic update — flip the visual immediately, roll back
    // if the PUT fails.
    setInFocus(nextInFocus);
    startTransition(async () => {
      try {
        const currentTickers =
          initialState.preferences?.focusTickers ?? [];
        const nextTickers = nextInFocus
          ? Array.from(new Set([...currentTickers, ticker]))
          : currentTickers.filter((t) => t !== ticker);
        const nextState: SharedState = {
          ...initialState,
          preferences: initialState.preferences
            ? { ...initialState.preferences, focusTickers: nextTickers }
            : {
                focusTickers: nextTickers,
                themes: initialState.themes ?? [],
                subscriptions: {
                  newTranscripts: false,
                  weekAhead: false,
                  ideasDigest: false,
                },
              },
        };
        const r = await fetch("/api/shared-state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextState),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.message ?? `HTTP ${r.status}`);
        }
      } catch (e) {
        setInFocus(!nextInFocus); // rollback
        setError((e as Error).message);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      title={
        inFocus
          ? "Remove from focus (updates shared-state via PUT)"
          : "Add to focus (updates shared-state via PUT)"
      }
      aria-pressed={inFocus}
      className={clsx(
        "inline-flex h-8 items-center gap-1.5 rounded-button border px-3 text-[12.5px] transition",
        inFocus
          ? "border-brand bg-[rgba(47,127,255,0.10)] text-brand-fg"
          : "border-bd bg-s1 text-tx-mid hover:bg-hover hover:text-tx",
        pending && "opacity-60",
      )}
    >
      {inFocus ? (
        <Star size={12} className="fill-current" />
      ) : (
        <StarOff size={12} />
      )}
      {inFocus ? "In focus" : "Add to focus"}
      {error ? (
        <span className="ml-1 text-[10.5px] text-danger" title={error}>
          · fail
        </span>
      ) : null}
    </button>
  );
}
