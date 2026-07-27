"use client";

// Manual value entry. MANDATORY source + as-of validation — blocked otherwise.
// Wired to POST /api/manual-entry (W4). Per-field errors from the server are
// merged onto the client's form-level `errors` map.

import { useEffect, useMemo, useState } from "react";
import type { Entity, EventRecord, MetricDictionary } from "@/lib/types";
import {
  Button,
  Input,
  Label,
  FieldError,
  FieldHint,
  Panel,
} from "@/components/primitives";
import { useToast } from "@/providers/ToastProvider";
import { usePersistence } from "@/providers/PersistenceProvider";
import { api, ApiError } from "@/lib/apiClient";

interface Props {
  entity: Entity;
  events: EventRecord[];
}

export function ManualEntryForm({ entity, events }: Props) {
  const { push } = useToast();
  const { markSyncing, markSynced, markLocal } = usePersistence();
  const [dictionary, setDictionary] = useState<MetricDictionary["metrics"]>({});
  useEffect(() => {
    let cancelled = false;
    api
      .getDictionary()
      .then((d) => {
        if (cancelled) return;
        const metrics = (d as MetricDictionary).metrics ?? {};
        setDictionary(metrics);
        // Backfill the unit input once the dictionary loads if the user
        // hasn't touched it yet.
        setUnit((u) => u || metrics[entity.headlineMetrics[0]]?.unit || "");
      })
      .catch(() => {
        /* form still renders — metric picker just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [entity.headlineMetrics]);
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [metric, setMetric] = useState(entity.headlineMetrics[0] ?? "");
  const [slot, setSlot] = useState<"actual" | "estimate" | "prior">("actual");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [source, setSource] = useState("");
  const [asOf, setAsOf] = useState("");
  const [method, setMethod] = useState<
    "bloomberg_manual" | "filing_manual" | "llm_extracted"
  >("bloomberg_manual");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === eventId) ?? null,
    [events, eventId],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const err: Record<string, string> = {};
    if (!eventId) err.eventId = "Event required";
    if (!metric) err.metricKey = "Metric required";
    if (!value) err.value = "Value required";
    if (!source.trim()) err.sourceUrl = "Source URL required — no blind entry";
    if (!asOf) err.asOf = "As-of date required";
    setErrors(err);
    if (Object.keys(err).length) return;

    setSubmitting(true);
    markSyncing();
    try {
      await api.postManualEntry({
        eventId,
        metricKey: metric,
        slot,
        value: Number(value),
        unit,
        sourceUrl: source.trim(),
        asOf,
        method,
        displayLabel: dictionary[metric]?.label ?? metric,
        isHeadline: entity.headlineMetrics.includes(metric),
      });
      markSynced();
      push({
        kind: "success",
        message: `Saved ${dictionary[metric]?.label ?? metric} · ${slot}`,
      });
      setValue("");
      setSource("");
      setAsOf("");
      setErrors({});
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.fields) setErrors(e.fields);
        if (e.status === 503) {
          markLocal();
          push({
            kind: "warning",
            message: "Local only — set GH_PAT in Vercel env to enable writes",
          });
        } else {
          markSynced();
          push({ kind: "danger", message: e.message });
        }
      } else {
        markSynced();
        push({ kind: "danger", message: (e as Error).message });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Panel eyebrow={`Manual value · ${entity.displayName}`}>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label required>Event</Label>
            {events.length === 0 ? (
              <FieldError>
                No events yet for {entity.ticker} — create one before manual
                entry.
              </FieldError>
            ) : (
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
              >
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.period} · {ev.scheduledDate}
                    {ev.eventDate ? " · reported" : ""}
                  </option>
                ))}
              </select>
            )}
            {errors.eventId ? <FieldError>{errors.eventId}</FieldError> : null}
            {selectedEvent ? (
              <FieldHint>
                Event id: <span className="font-mono">{selectedEvent.id}</span>
              </FieldHint>
            ) : null}
          </div>

          <div>
            <Label required>Metric</Label>
            <select
              value={metric}
              onChange={(e) => {
                setMetric(e.target.value);
                setUnit(dictionary[e.target.value]?.unit ?? "");
              }}
              className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
            >
              {Object.entries(dictionary).map(([k, meta]) => (
                <option key={k} value={k}>
                  {meta.label} · {k}
                </option>
              ))}
            </select>
            {errors.metricKey ? (
              <FieldError>{errors.metricKey}</FieldError>
            ) : null}
          </div>
          <div>
            <Label required>Slot</Label>
            <select
              value={slot}
              onChange={(e) => setSlot(e.target.value as typeof slot)}
              className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
            >
              <option value="actual">actual</option>
              <option value="estimate">estimate</option>
              <option value="prior">prior</option>
            </select>
            {errors.slot ? <FieldError>{errors.slot}</FieldError> : null}
          </div>

          <div>
            <Label required>Value</Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. 16100"
              mono
              invalid={!!errors.value}
            />
            {errors.value ? <FieldError>{errors.value}</FieldError> : null}
          </div>
          <div>
            <Label>Unit</Label>
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} mono />
            {errors.unit ? <FieldError>{errors.unit}</FieldError> : null}
          </div>

          <div className="col-span-2">
            <Label required hint="mandatory — no blind entry">
              Source URL
            </Label>
            <Input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://…"
              invalid={!!errors.sourceUrl}
            />
            {errors.sourceUrl ? (
              <FieldError>{errors.sourceUrl}</FieldError>
            ) : (
              <FieldHint>
                Every manual figure must carry the URL that supports it.
              </FieldHint>
            )}
          </div>

          <div>
            <Label required>As-of date</Label>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              invalid={!!errors.asOf}
            />
            {errors.asOf ? <FieldError>{errors.asOf}</FieldError> : null}
          </div>
          <div>
            <Label required>Method</Label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
            >
              <option value="bloomberg_manual">bloomberg_manual</option>
              <option value="filing_manual">filing_manual</option>
              <option value="llm_extracted">llm_extracted</option>
            </select>
            {errors.method ? <FieldError>{errors.method}</FieldError> : null}
          </div>
        </div>
      </Panel>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" type="button">
          Discard
        </Button>
        <Button type="submit" disabled={submitting || events.length === 0}>
          {submitting ? "Saving…" : "Save value"}
        </Button>
      </div>
    </form>
  );
}
