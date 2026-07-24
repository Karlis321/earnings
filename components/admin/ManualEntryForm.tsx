"use client";

// Manual value entry. MANDATORY source + as-of validation — blocked otherwise.
// Backend integration flag: save writes to earnings.json via commit-pipe (P8-T3).

import { useState } from "react";
import type { Entity } from "@/lib/types";
import {
  Button,
  Input,
  Label,
  FieldError,
  FieldHint,
  Panel,
} from "@/components/primitives";
import { METRIC_LABELS } from "@/lib/fixtures/registry";
import { useToast } from "@/providers/ToastProvider";

export function ManualEntryForm({ entity }: { entity: Entity }) {
  const { push } = useToast();
  const [period, setPeriod] = useState("");
  const [metric, setMetric] = useState(entity.headlineMetrics[0] ?? "");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState(
    METRIC_LABELS[entity.headlineMetrics[0]]?.unit ?? "",
  );
  const [source, setSource] = useState("");
  const [asOf, setAsOf] = useState("");
  const [method, setMethod] = useState<
    "bloomberg_manual" | "filing_manual" | "llm_extracted"
  >("bloomberg_manual");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const err: Record<string, string> = {};
    if (!period) err.period = "Period required (e.g. FY2026 Q2)";
    if (!metric) err.metric = "Metric required";
    if (!value) err.value = "Value required";
    if (!source.trim()) err.source = "Source URL required — no blind entry";
    if (!asOf) err.asOf = "As-of date required";
    setErrors(err);
    if (Object.keys(err).length) return;
    push({ kind: "info", message: `Saved locally · commit needs backend earnings store` });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Panel eyebrow={`Manual value · ${entity.displayName}`}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label required>Period</Label>
            <Input
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              placeholder="FY2026 Q2"
              invalid={!!errors.period}
            />
            {errors.period ? <FieldError>{errors.period}</FieldError> : null}
          </div>
          <div>
            <Label required>Metric</Label>
            <select
              value={metric}
              onChange={(e) => {
                setMetric(e.target.value);
                setUnit(METRIC_LABELS[e.target.value]?.unit ?? "");
              }}
              className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
            >
              {Object.entries(METRIC_LABELS).map(([k, meta]) => (
                <option key={k} value={k}>
                  {meta.label} · {k}
                </option>
              ))}
            </select>
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
          </div>

          <div className="col-span-2">
            <Label required hint="mandatory — no blind entry">
              Source URL
            </Label>
            <Input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://…"
              invalid={!!errors.source}
            />
            {errors.source ? (
              <FieldError>{errors.source}</FieldError>
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
          </div>
        </div>
      </Panel>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" type="button">
          Discard
        </Button>
        <Button type="submit">Save value</Button>
      </div>
    </form>
  );
}
