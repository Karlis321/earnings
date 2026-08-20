// Server component (no interactivity). Snapshot table for the
// AI-writing and data-pipeline outputs: shows each file's
// generatedAt, item count, and next-fire cadence so the user can
// see at a glance which surface is stale + when to expect the
// next update.

import { Panel } from "@/components/primitives";
import type {
  Ideas,
  MacroSignals,
  Ranking,
  Screen,
  WeekAheadNarrative,
} from "@/lib/types";

interface Props {
  ranking: Ranking | null;
  ideas: Ideas | null;
  macro: MacroSignals | null;
  narrative: WeekAheadNarrative | null;
  blueOcean: Screen | null;
  ruleBreaker: Screen | null;
}

interface Row {
  label: string;
  file: string;
  generatedAt: string | null;
  count: number | null;
  countLabel: string;
  cadence: string;
  route: string;
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

function ageBadge(hours: number | null): {
  label: string;
  color: string;
} {
  if (hours == null) return { label: "no data", color: "text-tx3" };
  if (hours < 6) return { label: `${hours}h ago`, color: "text-success-fg" };
  if (hours < 48)
    return { label: `${hours}h ago`, color: "text-brand-fg" };
  if (hours < 168) {
    const d = Math.floor(hours / 24);
    return { label: `${d}d ago`, color: "text-tx-mid" };
  }
  const d = Math.floor(hours / 24);
  return {
    label: `${d}d ago`,
    color: "text-[rgba(202,138,4,1)]",
  };
}

export function DataSnapshotsPanel({
  ranking,
  ideas,
  macro,
  narrative,
  blueOcean,
  ruleBreaker,
}: Props) {
  const rows: Row[] = [
    {
      label: "Ranking",
      file: "data/ranking.json",
      generatedAt: ranking?.generatedAt ?? null,
      count: ranking?.stats.scored ?? null,
      countLabel: "scored",
      cadence: "on demand (before Ideas + Week Ahead runs)",
      route: "/ideas",
    },
    {
      label: "Ideas pitches",
      file: "data/ideas.json",
      generatedAt: ideas?.generatedAt ?? null,
      count: ideas?.pitches.length ?? null,
      countLabel: "pitches",
      cadence: "Mon / Wed / Fri · 14:00 UTC",
      route: "/ideas",
    },
    {
      label: "Macro signals",
      file: "data/macro-signals.json",
      generatedAt: macro?.generatedAt ?? null,
      count: macro?.signals.length ?? null,
      countLabel: "series",
      cadence: "daily (03:00 UTC · refresh-universe phase)",
      route: "/week-ahead",
    },
    {
      label: "Week-Ahead narrative",
      file: "data/week-ahead-narrative.json",
      generatedAt: narrative?.generatedAt ?? null,
      count: narrative?.highlights.length ?? null,
      countLabel: "highlights",
      cadence: "Sunday · 22:00 UTC",
      route: "/week-ahead",
    },
    {
      label: "Blue Ocean screen",
      file: "data/screens/blue-ocean.json",
      generatedAt: blueOcean?.generatedAt ?? null,
      count: blueOcean?.screens.length ?? null,
      countLabel: "companies",
      cadence: "1st of month · 12:00 UTC (self-chains)",
      route: "/screens?framework=blue-ocean",
    },
    {
      label: "Rule Breaker screen",
      file: "data/screens/rule-breaker.json",
      generatedAt: ruleBreaker?.generatedAt ?? null,
      count: ruleBreaker?.screens.length ?? null,
      countLabel: "companies",
      cadence: "2nd of month · 12:00 UTC (self-chains)",
      route: "/screens?framework=rule-breaker",
    },
  ];

  return (
    <Panel eyebrow="Data snapshots">
      <p className="mb-3 text-[12.5px] text-tx-mid">
        AI-writing and data-pipeline output files. Cadence is the
        workflow schedule; "no data" means the workflow hasn&apos;t
        fired yet (or the file was never committed). Manual dispatch
        available from the repo Actions tab for any of these.
      </p>
      <div className="overflow-hidden rounded-[6px] border border-bd">
        <div className="grid grid-cols-[14rem_5rem_7rem_1fr_8rem] gap-x-3 border-b border-bd bg-panel2/40 px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.07em] text-tx3">
          <span>File</span>
          <span className="text-right">Count</span>
          <span>Updated</span>
          <span>Cadence</span>
          <span className="text-right">Open</span>
        </div>
        {rows.map((r, i) => {
          const hours = hoursSince(r.generatedAt);
          const age = ageBadge(hours);
          return (
            <div
              key={i}
              className="grid grid-cols-[14rem_5rem_7rem_1fr_8rem] items-center gap-x-3 border-b border-bd/40 px-3 py-2 text-[12px]"
            >
              <span className="min-w-0">
                <span className="block truncate text-tx">{r.label}</span>
                <span className="block truncate font-mono text-[10px] text-tx3">
                  {r.file}
                </span>
              </span>
              <span className="text-right font-mono text-[11.5px] tabular-nums text-tx-mid">
                {r.count != null ? r.count : "—"}
                {r.count != null ? (
                  <span className="ml-1 text-[9.5px] text-tx3">
                    {r.countLabel}
                  </span>
                ) : null}
              </span>
              <span className={`font-mono text-[10.5px] ${age.color}`}>
                {age.label}
              </span>
              <span className="font-mono text-[10.5px] text-tx-mid">
                {r.cadence}
              </span>
              <a
                href={r.route}
                className="text-right font-mono text-[10.5px] text-brand-fg underline decoration-bd underline-offset-2 hover:decoration-brand-fg"
              >
                {r.route}
              </a>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
