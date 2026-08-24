"use client";

// Manual-dispatch panel on /settings. Each button POSTs to
// /api/dispatch with the workflow filename; auth is CRON_SECRET
// entered by the user and cached in sessionStorage. Bare bones
// UI — real quota mgmt happens in the workflow scaffolds
// themselves; this is a shortcut for "fire now" without opening
// the Actions tab.

import { useEffect, useState } from "react";
import { Panel } from "@/components/primitives";
import { Zap, KeyRound } from "lucide-react";

interface Workflow {
  file: string;
  label: string;
  description: string;
  inputs?: Array<{
    key: string;
    label: string;
    options?: string[];
    default?: string;
  }>;
}

const WORKFLOWS: Workflow[] = [
  {
    file: "sector-ideas.yml",
    label: "Sector themes (AI)",
    description:
      "Refreshes sector-signals + drafts 5-8 narrative themes on top. ~8-12 min. Every claim grounded in the mechanical rollup.",
  },
  {
    file: "week-ahead.yml",
    label: "Week-Ahead narrative",
    description:
      "Refreshes sector-signals + macro + drafts the narrative + highlights. ~8-12 min. Requires fresh underlying data.",
  },
  {
    file: "framework-screen.yml",
    label: "Framework screen",
    description:
      "Scores 8 tickers on the chosen framework's rubric. Self-chains to the next batch after 2-min quiet gap.",
    inputs: [
      {
        key: "framework",
        label: "Framework",
        options: ["blue-ocean", "rule-breaker"],
        default: "blue-ocean",
      },
      {
        key: "batch_size",
        label: "Batch",
        options: ["4", "8", "12"],
        default: "8",
      },
    ],
  },
];

const SECRET_STORAGE_KEY = "sig-cron-secret";

interface RowState {
  loading: boolean;
  message: string | null;
  error: boolean;
  inputs: Record<string, string>;
}

export function DispatchPanel() {
  const [secret, setSecret] = useState<string>("");
  const [state, setState] = useState<Record<string, RowState>>(() => {
    const init: Record<string, RowState> = {};
    for (const w of WORKFLOWS) {
      const inputs: Record<string, string> = {};
      for (const i of w.inputs ?? []) inputs[i.key] = i.default ?? "";
      init[w.file] = { loading: false, message: null, error: false, inputs };
    }
    return init;
  });

  useEffect(() => {
    try {
      const s = window.sessionStorage.getItem(SECRET_STORAGE_KEY);
      if (s) setSecret(s);
    } catch {
      // ignore
    }
  }, []);

  const persistSecret = (v: string) => {
    setSecret(v);
    try {
      if (v) window.sessionStorage.setItem(SECRET_STORAGE_KEY, v);
      else window.sessionStorage.removeItem(SECRET_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const dispatch = async (w: Workflow) => {
    if (!secret) {
      setState((s) => ({
        ...s,
        [w.file]: {
          ...s[w.file],
          message: "Enter CRON_SECRET above first.",
          error: true,
        },
      }));
      return;
    }
    setState((s) => ({
      ...s,
      [w.file]: { ...s[w.file], loading: true, message: null, error: false },
    }));
    try {
      const r = await fetch("/api/dispatch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          workflow: w.file,
          inputs: w.inputs ? state[w.file].inputs : undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      const ok = r.ok;
      setState((s) => ({
        ...s,
        [w.file]: {
          ...s[w.file],
          loading: false,
          message: ok
            ? j.message || `${w.file} dispatched`
            : j.message || `HTTP ${r.status}`,
          error: !ok,
        },
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        [w.file]: {
          ...s[w.file],
          loading: false,
          message: (e as Error).message,
          error: true,
        },
      }));
    }
  };

  return (
    <Panel eyebrow="Manual dispatch">
      <p className="mb-3 text-[12.5px] text-tx-mid">
        Fire an AI workflow now instead of waiting for its next scheduled
        slot. Requires the repo&apos;s <code>CRON_SECRET</code> — same
        value that <code>/api/summarize</code> checks. 5-min cooldown per
        workflow (rate-limits click-spam draining the AI quota pool).
      </p>

      <div className="mb-4 flex items-center gap-2">
        <KeyRound aria-hidden className="h-[13px] w-[13px] text-tx3" />
        <input
          type="password"
          value={secret}
          onChange={(e) => persistSecret(e.target.value)}
          placeholder="CRON_SECRET (cached in sessionStorage)"
          className="h-8 min-w-[280px] rounded-button border border-bd bg-s1 px-3 text-[12.5px] text-tx placeholder:text-tx3 focus:border-brand focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {WORKFLOWS.map((w) => {
          const rs = state[w.file];
          return (
            <div
              key={w.file}
              className="flex flex-col rounded-[6px] border border-bd bg-panel2/40 p-3"
            >
              <div className="mb-1 text-[13px] font-medium text-tx">
                {w.label}
              </div>
              <div className="mb-2 font-mono text-[10px] text-tx3">
                {w.file}
              </div>
              <div className="mb-3 text-[11.5px] leading-[1.45] text-tx-mid">
                {w.description}
              </div>
              {w.inputs && w.inputs.length > 0 ? (
                <div className="mb-3 flex flex-col gap-1.5">
                  {w.inputs.map((i) => (
                    <label
                      key={i.key}
                      className="flex items-center gap-2 font-mono text-[10.5px] text-tx-mid"
                    >
                      <span className="w-14 uppercase tracking-[0.06em] text-tx3">
                        {i.label}
                      </span>
                      <select
                        value={rs.inputs[i.key] ?? ""}
                        onChange={(e) =>
                          setState((s) => ({
                            ...s,
                            [w.file]: {
                              ...s[w.file],
                              inputs: {
                                ...s[w.file].inputs,
                                [i.key]: e.target.value,
                              },
                            },
                          }))
                        }
                        className="h-6 rounded border border-bd bg-s1 px-1 text-[11px] text-tx"
                      >
                        {(i.options ?? [""]).map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => dispatch(w)}
                disabled={rs.loading || !secret}
                className="mt-auto inline-flex h-8 items-center justify-center gap-1.5 rounded-button bg-brand px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Zap size={12} />
                {rs.loading ? "Dispatching…" : "Fire now"}
              </button>
              {rs.message ? (
                <div
                  className={`mt-2 font-mono text-[10.5px] ${rs.error ? "text-danger" : "text-success-fg"}`}
                >
                  {rs.message}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
