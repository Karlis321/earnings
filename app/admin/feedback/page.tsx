"use client";

// Feedback tables (sources / keywords / items).
// Backend integration flag: writes to /api/feedback (P8-T5).

import { data } from "@/lib/data";
import { Panel } from "@/components/primitives";
import { useToast } from "@/providers/ToastProvider";

export default function FeedbackPage() {
  const feedback = data.getFeedback();
  const { push } = useToast();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
          Feedback & source signals
        </h1>
        <p className="mt-1 text-[13.5px] text-tx-mid">
          Signals from the source panel — used to weight what surfaces in the
          next refresh window.
        </p>
      </div>

      <Panel eyebrow={`Recent · ${feedback.length}`} padded={false}>
        <div className="grid grid-cols-[100px_1fr_150px_100px_150px] gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
          <span>Target</span>
          <span>Target id</span>
          <span>Action</span>
          <span>By</span>
          <span className="text-right">When</span>
        </div>
        {feedback.map((f) => (
          <div
            key={f.id}
            className="grid grid-cols-[100px_1fr_150px_100px_150px] gap-3 border-b border-bd px-4 py-3 text-[12.5px]"
          >
            <span className="font-mono uppercase text-tx-mid">{f.target}</span>
            <span className="font-mono text-tx">{f.targetId}</span>
            <span className="text-tx">{f.action}</span>
            <span className="text-tx-mid">{f.createdBy}</span>
            <span className="text-right font-mono text-tx3">
              {f.createdAt.slice(0, 10)}
            </span>
          </div>
        ))}
        <div className="p-4">
          <button
            onClick={() =>
              push({
                kind: "info",
                message: "Adjust needs /api/feedback (backend)",
              })
            }
            className="text-[12.5px] text-brand-hi hover:text-brand-fg"
          >
            Adjust weights →
          </button>
        </div>
      </Panel>
    </div>
  );
}
