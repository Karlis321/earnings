"use client";

import { useEffect, useState } from "react";
import { Panel, StalenessLegend } from "@/components/primitives";
import { FEATURE_FLAGS } from "@/lib/flags";
import { api } from "@/lib/apiClient";

interface Health {
  ok: boolean;
  snapshotAt: string;
  ghPatPresent: boolean;
  mode: string;
  events: number;
  schema: string;
}

export default function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getHealth()
      .then((h) => setHealth(h as Health))
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="mx-auto max-w-[1400px] px-10 py-8">
      <h1 className="mb-6 text-[28px] font-semibold tracking-[-0.02em]">
        Settings
      </h1>

      <div className="flex flex-col gap-4">
        <Panel eyebrow="Appearance">
          <div className="text-[13.5px] text-tx2">
            Light theme only — navy on white, one font family. Toggle removed
            for consistency.
          </div>
        </Panel>

        <Panel eyebrow="Feature flags">
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(FEATURE_FLAGS).map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between rounded-button border border-bd bg-s1 px-3 py-[10px] text-[13px]"
              >
                <span className="font-mono text-tx">{k}</span>
                <span
                  className={`rounded-[4px] px-2 py-[1px] font-mono text-[11px] ${
                    v
                      ? "bg-[rgba(18,183,106,0.10)] text-success-fg"
                      : "bg-s3 text-tx-mid"
                  }`}
                >
                  {v ? "ON" : "OFF"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-tx-mid">
            LLM enrichment is <strong>OFF</strong> — $0 mode. Enable when you
            add an Anthropic key.
          </p>
        </Panel>

        <Panel eyebrow="Data status">
          {err ? (
            <div className="rounded-panel border border-[rgba(180,35,24,0.24)] bg-[rgba(180,35,24,0.05)] p-3 text-[12.5px] text-danger">
              Failed to load /api/health: {err}
            </div>
          ) : health ? (
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12.5px]">
              <span className="text-tx-mid">Health</span>
              <span className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    background: health.ok ? "var(--success)" : "var(--danger)",
                  }}
                />
                <span className="text-tx">{health.ok ? "ok" : "down"}</span>
              </span>
              <span className="text-tx-mid">Snapshot at</span>
              <span className="font-mono text-tx">{health.snapshotAt}</span>
              <span className="text-tx-mid">Schema</span>
              <span className="font-mono text-tx">{health.schema}</span>
              <span className="text-tx-mid">Events</span>
              <span className="font-mono text-tx">{health.events}</span>
              <span className="text-tx-mid">Store mode</span>
              <span className="font-mono text-tx">{health.mode}</span>
              <span className="text-tx-mid">GH_PAT present</span>
              <span className="font-mono text-tx">
                {health.ghPatPresent ? "yes" : "no · reads only"}
              </span>
              <span className="text-tx-mid">Freshness legend</span>
              <StalenessLegend />
            </div>
          ) : (
            <div className="text-[12.5px] text-tx-mid">Loading…</div>
          )}
          <p className="mt-4 rounded-panel border border-dashed border-bd bg-panel2 p-3 text-[12px] text-tx-mid">
            Per-engine reachability + per-ticker freshness land in W6 (cron
            metadata).
          </p>
        </Panel>
      </div>
    </div>
  );
}
