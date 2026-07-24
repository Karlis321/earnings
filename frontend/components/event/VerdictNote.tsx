"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, Check, AlertTriangle } from "lucide-react";
import { usePersistence } from "@/providers/PersistenceProvider";

interface Props {
  eventId: string;
  initial?: string;
}

export function VerdictNote({ eventId, initial }: Props) {
  const { markSyncing, markSynced, markLocal } = usePersistence();
  const [value, setValue] = useState(initial ?? "");
  const [editing, setEditing] = useState(!initial);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ta.current?.focus();
  }, [editing]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    markSyncing();
    try {
      const r = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/verdict-note`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: value }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (r.status === 503) {
          markLocal();
          setErr(
            j.message ??
              "Persistence unavailable · saved locally, will sync when GH_PAT is set.",
          );
        } else {
          setErr(j.message ?? `${r.status}`);
          markLocal();
        }
        return;
      }
      markSynced();
      setEditing(false);
    } catch (e) {
      markLocal();
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-panel border border-bd bg-s1 p-4">
      <div className="mono-eyebrow mb-2">Verdict note</div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            ref={ta}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={2}
            placeholder="Two-line take · what happened, what to watch next."
            className="w-full resize-none rounded-button border border-bd2 bg-s2 p-3 text-[13.5px] text-tx placeholder:text-tx3 outline-none focus:border-brand focus:shadow-[0_0_0_3px_rgba(47,127,255,0.18)]"
          />
          {err ? (
            <div className="flex items-center gap-2 rounded-button border border-[rgba(180,35,24,0.28)] bg-[rgba(180,35,24,0.05)] px-3 py-2 text-[12px] text-danger">
              <AlertTriangle size={12} />
              {err}
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex h-8 items-center gap-2 rounded-button bg-brand px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] disabled:opacity-60"
            >
              <Check size={12} />
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </div>
      ) : (
        <div
          className="group flex items-start gap-3 cursor-text"
          onClick={() => setEditing(true)}
        >
          <p className="text-[14px] leading-[1.6] text-tx-strong">
            {value || (
              <span className="text-tx-mid italic">Add a one-line verdict…</span>
            )}
          </p>
          <Pencil
            size={13}
            className="mt-1 text-tx-faint opacity-0 group-hover:opacity-100"
          />
        </div>
      )}
    </div>
  );
}
