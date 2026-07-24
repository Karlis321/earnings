"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, Check } from "lucide-react";
import { useRole } from "@/providers/RoleProvider";
import { usePersistence } from "@/providers/PersistenceProvider";

// Editor's one-line verdict — autosave via P3 optimistic layer.
// Backend integration flag (P6-T1): note persistence needs event-store write.

export function VerdictNote({ initial }: { initial?: string }) {
  const { isEditor } = useRole();
  const { markSyncing, markSynced } = usePersistence();
  const [value, setValue] = useState(initial ?? "");
  const [editing, setEditing] = useState(!initial);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ta.current?.focus();
  }, [editing]);

  const save = () => {
    markSyncing();
    // fixture: pretend to sync after a beat
    setTimeout(() => markSynced(), 700);
    setEditing(false);
  };

  if (!isEditor && !value) return null;

  return (
    <div className="rounded-panel border border-bd bg-s1 p-4">
      <div className="mono-eyebrow mb-2">Verdict note</div>
      {editing && isEditor ? (
        <div className="flex flex-col gap-2">
          <textarea
            ref={ta}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={2}
            placeholder="Two-line take · what happened, what to watch next."
            className="w-full resize-none rounded-button border border-bd2 bg-s2 p-3 text-[13.5px] text-tx placeholder:text-tx3 outline-none focus:border-brand focus:shadow-[0_0_0_3px_rgba(47,127,255,0.18)]"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={save}
              className="inline-flex h-8 items-center gap-2 rounded-button bg-brand px-3 text-[12.5px] font-medium text-white shadow-[0_2px_8px_rgba(47,127,255,0.35)]"
            >
              <Check size={12} /> Save note
            </button>
          </div>
        </div>
      ) : (
        <div
          className="group flex items-start gap-3"
          onClick={() => isEditor && setEditing(true)}
        >
          <p className="text-[14px] leading-[1.6] text-tx-strong">
            {value || (
              <span className="text-tx-mid italic">Add a one-line verdict…</span>
            )}
          </p>
          {isEditor && (
            <Pencil
              size={13}
              className="mt-1 text-tx-faint opacity-0 group-hover:opacity-100"
            />
          )}
        </div>
      )}
    </div>
  );
}
