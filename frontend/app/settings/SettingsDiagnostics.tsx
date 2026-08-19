"use client";

// Diagnostic panels on /settings — appearance note, feature flag table,
// data status, last cron run. Split out from the page shell so the page
// can be a server component that pre-fetches shared-state + entity
// registry for the preferences form above.

import { Panel, StalenessLegend } from "@/components/primitives";
import { FEATURE_FLAGS } from "@/lib/flags";
import { useHealth } from "@/lib/useHealth";

export function SettingsDiagnostics() {
  const { health, error } = useHealth();

  return (
    <>
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
        {error ? (
          <div className="rounded-panel border border-[rgba(180,35,24,0.24)] bg-[rgba(180,35,24,0.05)] p-3 text-[12.5px] text-danger">
            Failed to load /api/health: {error}
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
      </Panel>

      {health ? (
        <Panel eyebrow="Last cron run">
          {health.lastCronRun ? (
            <>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12.5px]">
                <span className="text-tx-mid">Finished at</span>
                <span className="font-mono text-tx">
                  {health.lastCronRun}
                </span>
                <span className="text-tx-mid">Result</span>
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      background: health.lastCronOk
                        ? "var(--success)"
                        : "var(--danger)",
                    }}
                  />
                  <span className="text-tx">
                    {health.lastCronOk ? "ok" : "errors"}
                  </span>
                </span>
                <span className="text-tx-mid">Duration</span>
                <span className="font-mono text-tx">
                  {health.cronDurationMs != null
                    ? `${(health.cronDurationMs / 1000).toFixed(1)}s`
                    : "—"}
                </span>
                <span className="text-tx-mid">Sources appended</span>
                <span className="font-mono text-tx">{health.totalAppended}</span>
                <span className="text-tx-mid">Horizons matured</span>
                <span className="font-mono text-tx">{health.totalMatured}</span>
              </div>

              <div className="mt-4">
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-tx3">
                  Engines
                </div>
                <div className="flex flex-wrap gap-2">
                  {health.engines.length === 0 ? (
                    <span className="text-[12px] text-tx-mid">
                      no engine data yet
                    </span>
                  ) : (
                    health.engines.map((es) => (
                      <span
                        key={es.engine}
                        className="inline-flex h-[24px] items-center gap-[6px] rounded-[5px] border border-bd2 bg-s2 px-[9px] font-mono text-[11px]"
                      >
                        <span
                          className={`h-[6px] w-[6px] rounded-full ${
                            es.ok ? "bg-success" : "bg-danger"
                          }`}
                        />
                        <span className="text-tx">{es.engine}</span>
                        {es.itemsFound != null ? (
                          <span className="text-tx-mid">· {es.itemsFound}</span>
                        ) : null}
                      </span>
                    ))
                  )}
                </div>
              </div>

              {health.cronEventSummaries.length > 0 ? (
                <div className="mt-4">
                  <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-tx3">
                    Per-event
                  </div>
                  <div className="grid grid-cols-1 gap-[2px] font-mono text-[11.5px]">
                    {health.cronEventSummaries.map((e) => (
                      <div
                        key={e.eventId}
                        className="flex items-center gap-3 border-b border-bd/40 py-1"
                      >
                        <span className="text-tx">{e.ticker}</span>
                        <span className="text-tx-mid">+{e.appended}</span>
                        <span className="text-tx-mid">
                          m: {e.maturedHorizons.join(",") || "—"}
                        </span>
                        {e.errors.length > 0 ? (
                          <span className="text-danger">
                            {e.errors.length} err
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {health.newEvents.length > 0 ? (
                <div className="mt-4">
                  <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-tx3">
                    New events detected · {health.newEvents.length}
                  </div>
                  <div className="grid grid-cols-1 gap-[2px] font-mono text-[11.5px]">
                    {health.newEvents.map((e) => (
                      <div
                        key={e.eventId}
                        className="flex items-center gap-3 border-b border-bd/40 py-1"
                      >
                        <span className="text-tx">{e.ticker}</span>
                        <span className="text-tx-mid">{e.period}</span>
                        <span className="text-tx-mid">{e.scheduledDate}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {health.documents.attempted > 0 ? (
                <div className="mt-4">
                  <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-tx3">
                    Documents · {health.documents.ingested} new /{" "}
                    {health.documents.unchanged} unchanged /{" "}
                    {health.documents.failed} failed
                  </div>
                  {health.documents.recent.length > 0 ? (
                    <div className="grid grid-cols-1 gap-[2px] font-mono text-[11.5px]">
                      {health.documents.recent.slice(0, 8).map((d) => (
                        <div
                          key={d.id}
                          className="flex items-center gap-3 border-b border-bd/40 py-1"
                        >
                          <span className="text-tx">{d.kind ?? "—"}</span>
                          <span className="text-tx-mid">
                            v{d.ingestVersion}
                            {d.changed ? " ·new" : ""}
                          </span>
                          <span className="truncate text-tx-mid">
                            {d.url}
                          </span>
                          {d.error ? (
                            <span className="text-danger">{d.error}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {health.restatements.length > 0 ? (
                <div className="mt-4">
                  <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-tx3">
                    Restatements · {health.restatements.length}
                  </div>
                  <div className="grid grid-cols-1 gap-[2px] font-mono text-[11.5px]">
                    {health.restatements.map((r, i) => (
                      <div
                        key={`${r.eventId}-${r.metricKey}-${i}`}
                        className="flex items-center gap-3 border-b border-bd/40 py-1"
                      >
                        <span className="text-tx">{r.ticker}</span>
                        <span className="text-tx-mid">{r.metricKey}</span>
                        <span className="text-tx-mid">
                          {r.priorValue.toFixed(3)} → {r.restatedValue.toFixed(3)}
                        </span>
                        <span
                          className={
                            r.deltaPct >= 5 ? "text-danger" : "text-warning"
                          }
                        >
                          Δ {r.deltaPct.toFixed(2)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-[12.5px] text-tx-mid">
              Cron hasn't run yet.
            </div>
          )}
        </Panel>
      ) : null}
    </>
  );
}
