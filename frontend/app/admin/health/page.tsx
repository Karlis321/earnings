import { store } from "@/server/store";
import { Panel } from "@/components/primitives";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import clsx from "clsx";
import type { CronRunSummary } from "@/lib/types";
import type {
  PipelineHistoryEntry,
  PipelineReport,
} from "@/server/lib/pipelineReport";

// Small internal health page. Renders the last cron-status snapshot so
// "is the pipeline alive?" is a glance, not a repo dig.
export const dynamic = "force-dynamic";

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export default async function HealthPage() {
  const [status, entities, snapshot, report, history] = await Promise.all([
    store.readCronStatus(),
    store.readRegistry(),
    store.readEarnings(),
    store.readPipelineReport?.() ?? Promise.resolve(null),
    store.readPipelineHistory?.() ?? Promise.resolve([]),
  ]);

  const s = status as CronRunSummary | null;
  const ok = s?.ok === true;
  const hasErrors =
    s?.events?.some((e) => e.errors && e.errors.length > 0) ?? false;
  const totalErrors =
    s?.events?.reduce((n, e) => n + (e.errors?.length ?? 0), 0) ?? 0;

  // Coverage snapshot from the registry + earnings we just read.
  const totalEntities = entities.length;
  const withMarketCap = entities.filter(
    (e) => e.marketCapUsd != null,
  ).length;
  const withCik = entities.filter((e) => e.edgarCik).length;
  const withTtm = entities.filter(
    (e) => e.fundamentals && e.fundamentals.totalRevenueTTM != null,
  ).length;
  const withSources = entities.filter(
    (e) => (e.sourceCount ?? 0) > 0,
  ).length;
  const eventCount = snapshot.events.length;
  const pastEvents = snapshot.events.filter((e) => e.eventDate).length;
  const withBaseline = snapshot.events.filter(
    (e) => e.reaction?.baselineDate,
  ).length;
  const maturedHorizons = snapshot.events.reduce(
    (n, ev) =>
      n +
      (ev.reaction?.points?.filter((p) => p.absReturn !== null).length ?? 0),
    0,
  );

  return (
    <div className="mx-auto max-w-[1400px] px-10 py-8">
      <div className="mb-5">
        <Breadcrumb
          crumbs={[
            { label: "Overview", href: "/" },
            { label: "Admin", href: "/admin" },
            { label: "Health" },
          ]}
        />
      </div>
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Health</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          Pipeline health
        </h1>
        <p className="mt-2 max-w-[64ch] text-[13.5px] text-tx2">
          Last cron run + per-vendor status + coverage counters. Renders
          live from <code>data/cron-status.json</code>,
          <code>data/entity-registry.json</code>, and
          <code>data/earnings.json</code>.
        </p>
      </div>

      <PipelineStrip report={report as PipelineReport | null} />
      <PipelineSparklines history={(history as PipelineHistoryEntry[]).slice(-30)} />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel eyebrow="Last cron run">
          {s ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                {ok ? (
                  <CheckCircle2 size={22} className="text-success-fg" />
                ) : (
                  <XCircle size={22} className="text-danger" />
                )}
                <div className="flex flex-col">
                  <span className="text-[16px] font-semibold text-tx">
                    {ok ? "OK" : "Failed"}
                  </span>
                  <span className="font-mono text-[12px] text-tx-mid">
                    {fmtRelative(s.finishedAt ?? null)} · duration{" "}
                    {fmtDuration(s.durationMs)}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-[12.5px]">
                <div className="rounded-card border border-bd bg-s1 p-3">
                  <div className="mono-eyebrow mb-1">Started</div>
                  <div className="font-mono text-[11.5px] text-tx">
                    {s.startedAt}
                  </div>
                </div>
                <div className="rounded-card border border-bd bg-s1 p-3">
                  <div className="mono-eyebrow mb-1">Finished</div>
                  <div className="font-mono text-[11.5px] text-tx">
                    {s.finishedAt}
                  </div>
                </div>
                <div className="rounded-card border border-bd bg-s1 p-3">
                  <div className="mono-eyebrow mb-1">Appended</div>
                  <div className="font-mono text-[16px] tabular-nums text-tx-strong">
                    {s.totalAppended ?? 0}
                  </div>
                </div>
                <div className="rounded-card border border-bd bg-s1 p-3">
                  <div className="mono-eyebrow mb-1">Matured</div>
                  <div className="font-mono text-[16px] tabular-nums text-tx-strong">
                    {s.totalMatured ?? 0}
                  </div>
                </div>
              </div>
              {hasErrors ? (
                <div className="flex items-start gap-2 rounded-card border border-warning/40 bg-[rgba(181,71,8,0.08)] p-3 text-[12.5px] text-warning">
                  <AlertTriangle size={14} className="mt-[1px] flex-none" />
                  <span>
                    {totalErrors} per-event errors this run (see event
                    summary below).
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-[13px] text-tx-mid">
              No cron-status file yet. Cron hasn't run against this store.
            </div>
          )}
        </Panel>

        <Panel eyebrow="Coverage">
          <div className="flex flex-col gap-2 text-[12.5px]">
            <Row label="Entities" v={totalEntities} d="total in registry" />
            <Row
              label="Market cap"
              v={`${withMarketCap}/${totalEntities}`}
              d={`${((withMarketCap / totalEntities) * 100).toFixed(0)}% populated`}
            />
            <Row
              label="EDGAR CIK"
              v={String(withCik)}
              d="SEC filers resolved"
            />
            <Row
              label="TTM fundamentals"
              v={`${withTtm}/${totalEntities}`}
              d={`${((withTtm / totalEntities) * 100).toFixed(0)}% populated`}
            />
            <Row
              label="Source count > 0"
              v={`${withSources}/${totalEntities}`}
              d={`${((withSources / totalEntities) * 100).toFixed(0)}% populated`}
            />
            <div className="my-2 h-px bg-bd" />
            <Row label="Events" v={eventCount} d="total in earnings.json" />
            <Row
              label="Past events"
              v={pastEvents}
              d="have eventDate set"
            />
            <Row
              label="Baselines seeded"
              v={withBaseline}
              d="reaction can compute"
            />
            <Row
              label="Horizons matured"
              v={maturedHorizons}
              d="d1/d3/w1/m1 filled"
            />
          </div>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel eyebrow="Vendor engines" padded={false}>
          {s?.engines?.length ? (
            <div className="divide-y divide-bd">
              {s.engines.map((e, i) => (
                <div
                  key={`${e.engine}-${i}`}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3"
                >
                  <div className="flex items-center gap-2">
                    {e.ok ? (
                      <CheckCircle2 size={16} className="text-success-fg" />
                    ) : (
                      <XCircle size={16} className="text-danger" />
                    )}
                    <span className="font-mono text-[13px] text-tx">
                      {e.engine}
                    </span>
                  </div>
                  <span className="font-mono text-[12px] text-tx-mid">
                    {e.lastGood ? `last good ${e.lastGood.slice(0, 10)}` : ""}
                  </span>
                  <span className="font-mono text-[12.5px] tabular-nums text-tx-strong">
                    {e.itemsFound ?? 0} items
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-[13px] text-tx-mid">
              No engine status recorded on the last run.
            </div>
          )}
        </Panel>
      </div>

      {hasErrors ? (
        <div className="mt-4">
          <Panel
            eyebrow={`Per-event errors · ${totalErrors}`}
            padded={false}
          >
            <div className="max-h-[400px] overflow-y-auto divide-y divide-bd">
              {s!.events
                .filter((e) => e.errors && e.errors.length > 0)
                .slice(0, 200)
                .map((e) => (
                  <div
                    key={e.eventId}
                    className="grid grid-cols-[auto_1fr] items-start gap-3 px-4 py-2"
                  >
                    <span className="font-mono text-[11.5px] text-tx-mid">
                      {e.ticker}
                    </span>
                    <span
                      className={clsx(
                        "text-[12px]",
                        e.errors[0].startsWith("reaction:")
                          ? "text-tx-mid"
                          : "text-danger",
                      )}
                    >
                      {e.errors.join(" · ")}
                    </span>
                  </div>
                ))}
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  v,
  d,
}: {
  label: string;
  v: string | number;
  d: string;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-bd/50 pb-1.5">
      <div className="text-tx">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[14px] font-semibold tabular-nums text-tx-strong">
          {v}
        </span>
        <span className="text-[11px] text-tx3">{d}</span>
      </div>
    </div>
  );
}

// Top status strip — green when the latest pipeline-report is ok, amber
// when degraded (with reasons listed). Absent report → neutral note.
function PipelineStrip({ report }: { report: PipelineReport | null }) {
  if (!report) {
    return (
      <div className="mb-4 rounded-card border border-bd bg-s1 px-4 py-3 text-[13px] text-tx-mid">
        No pipeline-report yet. The next cron run will produce one at{" "}
        <code>data/pipeline-report.json</code>.
      </div>
    );
  }
  const degraded = report.status === "degraded";
  return (
    <div
      className={clsx(
        "mb-4 rounded-card border px-4 py-3",
        degraded
          ? "border-warning/40 bg-[rgba(181,71,8,0.08)]"
          : "border-success/40 bg-[rgba(38,127,64,0.08)]",
      )}
    >
      <div className="flex items-center gap-3">
        {degraded ? (
          <AlertTriangle size={18} className="flex-none text-warning" />
        ) : (
          <CheckCircle2 size={18} className="flex-none text-success-fg" />
        )}
        <div className="flex flex-col leading-tight">
          <span className="text-[14px] font-semibold text-tx">
            Pipeline {degraded ? "degraded" : "ok"} · {report.date}
          </span>
          <span className="font-mono text-[11.5px] text-tx-mid">
            events {report.events_total} · +{report.events_added_today} today ·{" "}
            past {report.tickers_with_past_events} · forward{" "}
            {report.tickers_with_forward_dates} (
            {report.forward_dates_confirmed} confirmed /{" "}
            {report.forward_dates_estimated} estimated) · duration{" "}
            {(report.cron_duration_ms / 1000).toFixed(1)}s
          </span>
        </div>
      </div>
      {degraded && report.reasons.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 pl-6 text-[12px] text-warning">
          {report.reasons.map((r, i) => (
            <li key={i} className="list-disc">
              {r}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Inline SVG sparklines — no new dependency. Two mini-charts side by side:
// events_total (trend of corpus growth) and forward-date coverage
// (confirmed + estimated stacked as a single count).
function PipelineSparklines({ history }: { history: PipelineHistoryEntry[] }) {
  if (history.length < 2) {
    return (
      <div className="rounded-card border border-bd bg-s1 px-4 py-3 text-[12px] text-tx-mid">
        {history.length === 0
          ? "No pipeline history yet. Sparklines appear once a few cron runs have landed."
          : "Only one history point on file — sparkline appears after the second cron run."}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <SparkPanel
        eyebrow="events_total · last 30 days"
        values={history.map((h) => h.events_total)}
        labels={history.map((h) => h.date)}
      />
      <SparkPanel
        eyebrow="tickers_with_forward_dates · last 30 days"
        values={history.map((h) => h.tickers_with_forward_dates)}
        labels={history.map((h) => h.date)}
      />
    </div>
  );
}

function SparkPanel({
  eyebrow,
  values,
  labels,
}: {
  eyebrow: string;
  values: number[];
  labels: string[];
}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 320;
  const H = 60;
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = H - ((v - min) / range) * H;
      return `${x},${y}`;
    })
    .join(" ");
  const latest = values[values.length - 1];
  const first = values[0];
  const delta = latest - first;
  return (
    <Panel eyebrow={eyebrow}>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2 font-mono text-[13px] text-tx">
          <span className="text-[16px] font-semibold tabular-nums">{latest}</span>
          <span
            className={clsx(
              "text-[11.5px]",
              delta > 0 ? "text-success-fg" : delta < 0 ? "text-danger" : "text-tx-mid",
            )}
          >
            {delta === 0 ? "flat" : `${delta > 0 ? "+" : ""}${delta} vs ${labels[0]}`}
          </span>
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-14 w-full"
        >
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-brand-fg"
            points={points}
          />
        </svg>
      </div>
    </Panel>
  );
}
