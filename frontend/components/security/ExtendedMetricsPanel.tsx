"use client";

// Extended metrics panel — non-standard line items Claude extracted
// from the 10-Q / 8-K / EX-99. Displayed on the ticker page below
// the standard-metrics summary. Sector-aware: renders only the
// metrics the extractor found values for, ordered per the entity's
// applicable registry (universal first, then sector-specific).
//
// Every row includes a source tooltip with the exact filing quote —
// hover to verify, click to open the filing at the cited section.

import type { EventRecord, ExtendedMetricValue } from "@/lib/types";
import { Panel } from "@/components/primitives";
import { ExternalLink } from "lucide-react";

interface Props {
  event: EventRecord | undefined;
}

function formatValue(m: ExtendedMetricValue): string {
  if (m.value == null) return "—";
  const unit = m.unit;
  const v = m.value;
  if (unit === "pct") return v.toFixed(1) + "%";
  if (unit === "USD_m") return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + "M";
  if (unit === "USD") return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (unit === "USD/shares") return "$" + v.toFixed(2);
  if (unit === "USD/lb" || unit === "USD/oz" || unit === "USD/boe" || unit === "USD/bbl" || unit === "USD/mcf") return "$" + v.toFixed(2) + "/" + unit.split("/")[1];
  if (unit === "kt" || unit === "koz") return v.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " " + unit;
  if (unit === "boe/d") return v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " boe/d";
  if (unit === "count") return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (unit === "count-m") return v.toFixed(1) + "M";
  if (unit === "ratio") return v.toFixed(2) + "x";
  return v.toLocaleString("en-US") + " " + unit;
}

function formatRange(m: ExtendedMetricValue): string {
  if (m.low == null && m.high == null && m.value == null) return "—";
  if (m.low != null && m.high != null) {
    const dummy = (v: number) => formatValue({ ...m, value: v, shape: "point" });
    return `${dummy(m.low)} – ${dummy(m.high)}`;
  }
  return formatValue(m);
}

export function ExtendedMetricsPanel({ event }: Props) {
  const metrics = event?.extendedMetrics ?? [];
  if (metrics.length === 0) return null;
  return (
    <Panel eyebrow="Extended metrics · from filing" padded={false}>
      <div className="divide-y divide-bd">
        {metrics.map((m) => (
          <div
            key={m.key}
            className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5"
            title={`"${m.source.quote}"\n\n— ${m.source.section} · confidence ${(m.confidence * 100).toFixed(0)}%`}
          >
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] text-tx">{m.label}</span>
              <span className="mt-0.5 font-mono text-[10.5px] text-tx3">
                {m.source.section}
                {m.confidence < 0.9 ? (
                  <span className="ml-2 text-warning">
                    · confidence {(m.confidence * 100).toFixed(0)}%
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13.5px] tabular-nums text-tx">
                {m.shape === "range" ? formatRange(m) : formatValue(m)}
              </span>
              {m.source.url ? (
                <a
                  href={m.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-tx3 hover:text-tx"
                  title="Open filing"
                >
                  <ExternalLink size={11} />
                </a>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-bd bg-s1 px-4 py-2 text-[10.5px] text-tx3">
        Extracted by Claude from the filing document. Hover a row for the
        cited quote. Not standard GAAP — mgmt-defined or operational KPIs.
      </div>
    </Panel>
  );
}
