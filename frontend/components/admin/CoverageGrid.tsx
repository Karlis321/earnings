// Read-only coverage grid for /admin/entry/[ticker].
// Shows which (event × headlineMetric × slot) triples have Facts and which
// are empty, so the user can see what's missing at a glance before filling
// out the form below.

import type { Entity, EventRecord, Fact } from "@/lib/types";
import { Panel } from "@/components/primitives";
import { fmtDateShort } from "@/lib/format";
import { Check, Minus } from "lucide-react";
import clsx from "clsx";

interface Props {
  entity: Entity;
  events: EventRecord[];
}

function isFilled(f: Fact | null | undefined): boolean {
  return !!(f && f.value !== null && f.value !== undefined);
}

export function CoverageGrid({ entity, events }: Props) {
  const metrics = entity.headlineMetrics;
  if (metrics.length === 0 || events.length === 0) return null;

  const rows = events
    .slice()
    .sort((a, b) =>
      (b.eventDate ?? b.scheduledDate).localeCompare(
        a.eventDate ?? a.scheduledDate,
      ),
    );

  // Per-slot totals for the summary header.
  let filledActual = 0;
  let filledEstimate = 0;
  const cells = rows.length * metrics.length;
  for (const ev of rows) {
    for (const m of metrics) {
      const hit = ev.metrics.find((x) => x.key === m);
      if (isFilled(hit?.actual)) filledActual++;
      if (isFilled(hit?.estimate)) filledEstimate++;
    }
  }

  return (
    <Panel
      eyebrow={`Coverage · ${entity.headlineMetrics.length} headline metric${
        entity.headlineMetrics.length === 1 ? "" : "s"
      } × ${rows.length} event${rows.length === 1 ? "" : "s"}`}
      padded={false}
    >
      <div className="px-5 py-3 text-[12px] text-tx-mid">
        Actual: {filledActual}/{cells} · Estimate: {filledEstimate}/{cells}.
        Click a metric name in the form below to fill any empty slot.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-panel2">
            <tr className="border-b border-bd">
              <th className="sticky left-0 z-10 bg-panel2 px-4 py-2 text-left font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
                Event
              </th>
              {metrics.map((m) => (
                <th
                  key={m}
                  className="px-3 py-2 text-center font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3"
                  title={m}
                >
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((ev) => (
              <tr key={ev.id} className="border-b border-bd last:border-b-0">
                <td className="sticky left-0 z-10 bg-s1 px-4 py-2 text-tx">
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium">{ev.period}</span>
                    <span className="font-mono text-[10.5px] text-tx-mid">
                      {fmtDateShort(ev.eventDate ?? ev.scheduledDate)}
                      {ev.eventDate ? " · reported" : " · scheduled"}
                    </span>
                  </div>
                </td>
                {metrics.map((m) => {
                  const hit = ev.metrics.find((x) => x.key === m);
                  const actualFilled = isFilled(hit?.actual);
                  const estimateFilled = isFilled(hit?.estimate);
                  return (
                    <td key={m} className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <SlotDot
                          filled={actualFilled}
                          label="actual"
                          value={hit?.actual?.value ?? null}
                        />
                        <SlotDot
                          filled={estimateFilled}
                          label="est"
                          value={hit?.estimate?.value ?? null}
                        />
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SlotDot({
  filled,
  label,
  value,
}: {
  filled: boolean;
  label: string;
  value: number | null;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 min-w-[38px] items-center justify-center gap-1 rounded-[4px] px-1.5 font-mono text-[10.5px]",
        filled
          ? "bg-[rgba(3,152,85,0.10)] text-success-fg"
          : "border border-dashed border-bd2 text-tx3",
      )}
      title={
        filled
          ? `${label}: ${value ?? "—"}`
          : `${label}: missing`
      }
    >
      {filled ? <Check size={11} /> : <Minus size={11} />}
      {label}
    </span>
  );
}
