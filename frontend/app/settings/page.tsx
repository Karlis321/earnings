"use client";

import { Panel, StalenessLegend } from "@/components/primitives";
import { useTheme } from "@/providers/ThemeProvider";
import { FEATURE_FLAGS } from "@/lib/flags";
import { data } from "@/lib/data";

// Settings + Data Status. Data Status per-engine reachability is a P12-T2
// backend dependency; we render the last-known fixture snapshot until then.

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const snap = data.getSnapshot();

  return (
    <div className="mx-auto max-w-[1000px] px-10 py-8">
      <h1 className="mb-6 text-[28px] font-semibold tracking-[-0.02em]">
        Settings
      </h1>

      <div className="flex flex-col gap-4">
        <Panel eyebrow="Appearance">
          <div className="grid grid-cols-3 gap-2">
            {(["dark", "dim", "light"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`rounded-panel border p-4 text-left transition-colors ${
                  theme === t
                    ? "border-brand bg-brand/10"
                    : "border-bd bg-s1 hover:border-bd2"
                }`}
              >
                <div className="text-[14px] font-medium capitalize">{t}</div>
                <div className="mt-1 text-[11.5px] text-tx-mid">
                  {t === "dark"
                    ? "Default · deepest contrast"
                    : t === "dim"
                    ? "Softer nights"
                    : "Daylight review"}
                </div>
              </button>
            ))}
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
                      ? "bg-[rgba(52,211,153,0.12)] text-success-fg"
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
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12.5px]">
            <span className="text-tx-mid">Last snapshot</span>
            <span className="font-mono text-tx">{snap.lastUpdated}</span>
            <span className="text-tx-mid">Snapshot schema</span>
            <span className="font-mono text-tx">{snap.schema}</span>
            <span className="text-tx-mid">Events</span>
            <span className="font-mono text-tx">{snap.events.length}</span>
            <span className="text-tx-mid">Freshness legend</span>
            <StalenessLegend />
          </div>
          <p className="mt-4 rounded-panel border border-dashed border-bd bg-panel2 p-3 text-[12px] text-tx-mid">
            Per-engine reachability and per-ticker freshness detail land when
            <span className="font-mono"> /api/cron/daily </span>metadata is exposed
            (P12-T2 backend dep).
          </p>
        </Panel>
      </div>
    </div>
  );
}
