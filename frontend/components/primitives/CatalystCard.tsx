"use client";

import type { CatalystDetail } from "@/lib/types";
import { ExpectationTag } from "./ExpectationTag";
import { DeepLinkButton } from "./DeepLinkButton";
import { Beaker, FileText, Compass, Award } from "lucide-react";
import { fmtDate } from "@/lib/format";

const ICON_FOR: Record<string, React.ReactNode> = {
  PEA: <Award size={16} />,
  "Feasibility Study": <FileText size={16} />,
  "Drill Result": <Compass size={16} />,
  "Resource Update": <Beaker size={16} />,
  "Resource Estimate": <Beaker size={16} />,
  Permit: <FileText size={16} />,
};

export function CatalystCard({ catalyst }: { catalyst: CatalystDetail }) {
  const icon = ICON_FOR[catalyst.type] ?? <FileText size={16} />;
  const dateLine = catalyst.actualDate
    ? `Delivered ${fmtDate(catalyst.actualDate)}`
    : catalyst.expectedDate
    ? `Expected ${fmtDate(catalyst.expectedDate)}`
    : "Unscheduled";
  return (
    <div className="rounded-panel border border-bd bg-s1 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-[10px]">
          <div className="flex h-9 w-9 items-center justify-center rounded-card bg-[rgba(105,65,198,0.10)] text-dev-fg">
            {icon}
          </div>
          <div>
            <div className="text-[14.5px] font-semibold text-tx">
              {catalyst.title}
            </div>
            <div className="mono-caption normal-case tracking-normal text-[11.5px] text-tx-mid">
              {catalyst.type} · {dateLine}
            </div>
          </div>
        </div>
        <ExpectationTag expectation={catalyst.expectation} />
      </div>

      {catalyst.keyValues.length > 0 && (
        <dl className="grid grid-cols-3 gap-3 border-t border-bd pt-3">
          {catalyst.keyValues.map((kv) => (
            <div key={kv.label}>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-tx3">
                {kv.label}
              </dt>
              <dd className="mt-1 font-mono text-[13px] tabular-nums text-tx">
                {kv.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {catalyst.source ? (
        <div className="mt-4 flex justify-end">
          <DeepLinkButton source={catalyst.source} />
        </div>
      ) : null}
    </div>
  );
}
