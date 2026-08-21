"use client";

// Phase 4.1 — pairwise correlation heatmap. Cells are color-scaled
// from red (−1) → neutral (0) → green (+1). Diagonal (self) is
// suppressed to gray. Hover reveals the pair + numeric value +
// (from Phase 4.5 polish) each ticker's company name + industry
// tags so a reader unfamiliar with the tickers can still parse
// what's clustering.

import Link from "next/link";
import clsx from "clsx";
import type { Correlations } from "@/lib/types";

interface EntityMeta {
  displayName: string;
  primarySector: string | null;
  tags: string[];
}

interface Props {
  data: Correlations;
  entityMeta?: Record<string, EntityMeta>;
}

function cellBg(v: number | null, isSelf: boolean): string {
  if (isSelf) return "bg-panel3/60";
  if (v === null) return "bg-panel2/40";
  const clamped = Math.max(-1, Math.min(1, v));
  const abs = Math.abs(clamped);
  const alpha = (0.15 + abs * 0.55).toFixed(2);
  if (clamped >= 0) return `bg-[rgba(34,197,94,${alpha})]`;
  return `bg-[rgba(239,68,68,${alpha})]`;
}

function cellText(v: number | null, isSelf: boolean): string {
  if (isSelf) return "text-tx3";
  if (v === null) return "text-tx3";
  return Math.abs(v) > 0.55 ? "text-white" : "text-tx-hi";
}

function fmt(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(2);
}

function labelTitle(ticker: string, meta?: EntityMeta): string {
  if (!meta) return ticker;
  const bits = [ticker];
  if (meta.displayName) bits.push(meta.displayName);
  if (meta.primarySector) bits.push(meta.primarySector);
  return bits.join(" · ");
}

function cellTitle(
  a: string,
  b: string,
  v: number | null,
  isSelf: boolean,
  metaA?: EntityMeta,
  metaB?: EntityMeta,
): string {
  if (isSelf) return `${a} · self`;
  const nameA = metaA?.displayName ? ` (${metaA.displayName})` : "";
  const nameB = metaB?.displayName ? ` (${metaB.displayName})` : "";
  if (v === null) {
    return `${a}${nameA} vs ${b}${nameB} · insufficient overlap`;
  }
  return `${a}${nameA} vs ${b}${nameB} · ρ = ${v.toFixed(3)}`;
}

export function CorrelationHeatmap({ data, entityMeta }: Props) {
  const { tickers, matrix } = data;
  if (tickers.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-bd bg-panel2/40 px-4 py-6 text-[13px] text-tx-mid">
        Correlation snapshot is empty — the refresh script hasn't produced any tickers.
      </div>
    );
  }

  const CELL_PX = 44;
  const LABEL_PX = 220; // wide enough for "TICKER · Company Name"

  return (
    <div className="overflow-x-auto rounded-[8px] border border-bd bg-panel2/60">
      <table
        className="border-collapse font-mono text-[10.5px] tabular-nums"
        style={{ borderSpacing: 0 }}
      >
        <thead>
          <tr>
            <th
              className="sticky left-0 top-0 z-20 border-b border-bd bg-panel2 px-2 py-1 text-left text-tx3"
              style={{ width: LABEL_PX, minWidth: LABEL_PX }}
            >
              &nbsp;
            </th>
            {tickers.map((t) => {
              const meta = entityMeta?.[t];
              return (
                <th
                  key={t}
                  className="border-b border-bd bg-panel2 px-1 py-1 text-center text-tx-mid"
                  style={{ width: CELL_PX, minWidth: CELL_PX }}
                  title={labelTitle(t, meta)}
                >
                  <span className="inline-block rotate-[-45deg] whitespace-nowrap text-[10px]">
                    {t}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {tickers.map((rowTicker) => {
            const metaRow = entityMeta?.[rowTicker];
            return (
              <tr key={rowTicker}>
                <th
                  className="sticky left-0 z-10 border-r border-bd bg-panel2 px-2 py-1 text-right font-normal text-tx-mid"
                  style={{ width: LABEL_PX, minWidth: LABEL_PX }}
                  title={labelTitle(rowTicker, metaRow)}
                >
                  <Link
                    href={`/s/${encodeURIComponent(rowTicker)}`}
                    className="block truncate text-brand-fg hover:underline"
                  >
                    <span className="font-mono">{rowTicker}</span>
                    {metaRow?.displayName ? (
                      <span className="ml-1.5 font-sans text-[11px] text-tx-mid">
                        {metaRow.displayName}
                      </span>
                    ) : null}
                  </Link>
                  {metaRow?.primarySector ? (
                    <div className="mt-[1px] text-right text-[9px] uppercase tracking-[0.06em] text-tx3">
                      {metaRow.primarySector}
                    </div>
                  ) : null}
                </th>
                {tickers.map((colTicker) => {
                  const v = matrix[rowTicker]?.[colTicker] ?? null;
                  const isSelf = rowTicker === colTicker;
                  const metaCol = entityMeta?.[colTicker];
                  return (
                    <td
                      key={colTicker}
                      className={clsx(
                        "border-b border-r border-bd/40 px-0 py-1 text-center",
                        cellBg(v, isSelf),
                        cellText(v, isSelf),
                      )}
                      style={{ width: CELL_PX, minWidth: CELL_PX }}
                      title={cellTitle(
                        rowTicker,
                        colTicker,
                        v,
                        isSelf,
                        metaRow,
                        metaCol,
                      )}
                    >
                      {isSelf ? "·" : fmt(v)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
