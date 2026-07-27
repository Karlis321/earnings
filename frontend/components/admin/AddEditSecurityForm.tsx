"use client";

// Add / Edit Security form. Type-dependent fields, chip inputs, headline metric
// multi-select, benchmark validation, official-sources editor. (FE PRD §7.9)
// Wired to POST /api/entity-registry (new) + PUT /api/entity-registry/:ticker (edit).
// Ticker resolve → /api/ticker-lookup remains stubbed until W4.T1.

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Entity, SecurityType } from "@/lib/types";
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
import { usePersistence } from "@/providers/PersistenceProvider";
import { api, ApiError } from "@/lib/apiClient";
import { X, Plus, Search } from "lucide-react";

interface Props {
  initial?: Partial<Entity>;
  mode: "new" | "edit";
}

export function AddEditSecurityForm({ initial, mode }: Props) {
  const router = useRouter();
  const { push } = useToast();
  const { markSyncing, markSynced, markLocal } = usePersistence();
  const [ticker, setTicker] = useState(initial?.ticker ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [type, setType] = useState<SecurityType>(
    initial?.securityType ?? "operating",
  );
  const [listing, setListing] = useState(initial?.listing ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [benchmark, setBenchmark] = useState(initial?.benchmark ?? "");
  const [aliases, setAliases] = useState<string[]>(initial?.aliases ?? []);
  const [aliasInput, setAliasInput] = useState("");
  const [excl, setExcl] = useState<string[]>(initial?.exclusionAliases ?? []);
  const [exclInput, setExclInput] = useState("");
  const [sectorTags, setSectorTags] = useState<string[]>(initial?.sectorTags ?? []);
  const [sectorInput, setSectorInput] = useState("");
  const [headlineMetrics, setHeadlineMetrics] = useState<string[]>(
    initial?.headlineMetrics ?? [],
  );
  const [legalName, setLegalName] = useState(initial?.legalName ?? "");
  const [cashtag, setCashtag] = useState(initial?.cashtag ?? "");
  const [isCore, setIsCore] = useState(initial?.isCore ?? true);
  const [xHandle, setXHandle] = useState(initial?.xHandle ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const buildPayload = (): Partial<Entity> => ({
    ticker: ticker.trim(),
    displayName: displayName.trim(),
    legalName: legalName.trim() || displayName.trim(),
    securityType: type,
    listing: listing.trim(),
    currency: currency.trim() || "USD",
    benchmark: benchmark.trim(),
    aliases,
    exclusionAliases: excl,
    sectorTags,
    headlineMetrics,
    cashtag: cashtag.trim() ? cashtag.trim().toUpperCase() : null,
    isCore,
    coverage: initial?.coverage ?? "deep",
    catalystTypes: initial?.catalystTypes ?? [],
    xHandle: xHandle.trim() ? xHandle.trim().replace(/^@/, "") : null,
    officialSources: initial?.officialSources ?? [],
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const err: Record<string, string> = {};
    if (!ticker.trim()) err.ticker = "Ticker required";
    if (!displayName.trim()) err.displayName = "Display name required";
    if (type !== "developer" && !benchmark.trim())
      err.benchmark = "Benchmark required for operating and ETF names";
    if (type === "operating" && headlineMetrics.length === 0)
      err.headlineMetrics = "At least one headline metric required";
    setErrors(err);
    if (Object.keys(err).length) return;

    setSubmitting(true);
    markSyncing();
    try {
      if (mode === "new") {
        await api.postEntity(buildPayload());
        push({ kind: "success", message: `Added ${ticker.trim()}` });
      } else {
        await api.putEntity(initial!.ticker!, buildPayload());
        push({ kind: "success", message: `Updated ${initial!.ticker!}` });
      }
      markSynced();
      router.push("/admin");
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.fields) setErrors(e.fields);
        if (e.status === 503) {
          markLocal();
          push({
            kind: "warning",
            message: "Local only — set GH_PAT in Vercel env to enable writes",
          });
        } else if (e.status === 409) {
          markSynced();
          push({ kind: "danger", message: e.message });
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
      <div className="grid grid-cols-2 gap-4">
        <Panel eyebrow="Identity">
          <div className="mb-4">
            <Label required>Ticker (Bloomberg-style)</Label>
            <div className="flex gap-2">
              <Input
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                placeholder="e.g. INTC US · CS CN · RIO PA"
                mono
                invalid={!!errors.ticker}
              />
              <Button
                type="button"
                variant="secondary"
                size="md"
                leadingIcon={<Search size={12} />}
                onClick={() =>
                  push({
                    kind: "info",
                    message: "Resolve needs /api/ticker-lookup (backend)",
                  })
                }
              >
                Resolve
              </Button>
            </div>
            {errors.ticker ? <FieldError>{errors.ticker}</FieldError> : null}
          </div>

          <div className="mb-4">
            <Label required>Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              invalid={!!errors.displayName}
            />
            {errors.displayName ? (
              <FieldError>{errors.displayName}</FieldError>
            ) : null}
          </div>

          <div className="mb-4">
            <Label>Legal name</Label>
            <Input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Defaults to display name"
            />
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3">
            <div>
              <Label>Cashtag</Label>
              <Input
                value={cashtag}
                onChange={(e) => setCashtag(e.target.value.toUpperCase())}
                mono
                placeholder="INTC"
              />
              <FieldHint>
                Bare symbol without $. Used for $X mention matching.
              </FieldHint>
            </div>
            <div>
              <Label>X handle</Label>
              <Input
                value={xHandle}
                onChange={(e) => setXHandle(e.target.value.replace(/^@/, ""))}
                mono
                placeholder="intel"
              />
              <FieldHint>Without the @.</FieldHint>
            </div>
          </div>

          <div className="mb-4">
            <label className="flex items-center gap-2 text-[13px] text-tx">
              <input
                type="checkbox"
                checked={isCore}
                onChange={(e) => setIsCore(e.target.checked)}
              />
              <span>Core watchlist</span>
              <span className="ml-1 font-mono text-[11px] text-tx-mid">
                (uncheck for peer / benchmark holdings)
              </span>
            </label>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label required>Security type</Label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as SecurityType)}
                className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
              >
                <option value="operating">Operating</option>
                <option value="developer">Developer</option>
                <option value="etf">ETF</option>
              </select>
            </div>
            <div>
              <Label>Listing</Label>
              <Input
                value={listing}
                onChange={(e) => setListing(e.target.value)}
                placeholder="NYSE"
              />
            </div>
            <div>
              <Label>Currency</Label>
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                mono
              />
            </div>
          </div>
        </Panel>

        <Panel eyebrow="Coverage config">
          <div className="mb-4">
            <Label required={type !== "developer"}>
              Reaction benchmark ticker
            </Label>
            <Input
              value={benchmark}
              onChange={(e) => setBenchmark(e.target.value)}
              mono
              placeholder="SOX · HG=F · SPX"
              invalid={!!errors.benchmark}
            />
            {errors.benchmark ? (
              <FieldError>{errors.benchmark}</FieldError>
            ) : (
              <FieldHint>
                Required for operating & ETF. Developers can be left unset.
              </FieldHint>
            )}
          </div>

          <div className="mb-4">
            <Label>Sector tags</Label>
            <ChipInput
              values={sectorTags}
              input={sectorInput}
              onInput={setSectorInput}
              onAdd={() => {
                if (sectorInput.trim()) {
                  setSectorTags([...sectorTags, sectorInput.trim()]);
                  setSectorInput("");
                }
              }}
              onRemove={(v) =>
                setSectorTags(sectorTags.filter((s) => s !== v))
              }
              placeholder="Type & Enter"
            />
          </div>

          <div className="mb-4">
            <Label>Aliases</Label>
            <ChipInput
              values={aliases}
              input={aliasInput}
              onInput={setAliasInput}
              onAdd={() => {
                if (aliasInput.trim()) {
                  setAliases([...aliases, aliasInput.trim()]);
                  setAliasInput("");
                }
              }}
              onRemove={(v) => setAliases(aliases.filter((a) => a !== v))}
              placeholder="Names / cashtags / project names"
            />
          </div>

          <div>
            <Label>Exclusion aliases</Label>
            <ChipInput
              values={excl}
              input={exclInput}
              onInput={setExclInput}
              onAdd={() => {
                if (exclInput.trim()) {
                  setExcl([...excl, exclInput.trim()]);
                  setExclInput("");
                }
              }}
              onRemove={(v) => setExcl(excl.filter((x) => x !== v))}
              placeholder="Terms that must NOT match (e.g. Bambi)"
            />
          </div>
        </Panel>
      </div>

      {type === "operating" ? (
        <Panel eyebrow="Headline metrics · from canonical dictionary">
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(METRIC_LABELS).map(([key, meta]) => {
              const on = headlineMetrics.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    setHeadlineMetrics(
                      on
                        ? headlineMetrics.filter((k) => k !== key)
                        : [...headlineMetrics, key],
                    )
                  }
                  className={`flex items-center justify-between rounded-button border px-3 py-2 text-left text-[12.5px] ${
                    on
                      ? "border-brand bg-brand/10 text-brand-fg"
                      : "border-bd bg-s1 text-tx2 hover:text-tx"
                  }`}
                >
                  <span>
                    <div>{meta.label}</div>
                    <div className="font-mono text-[10px] text-tx3">
                      {key} · {meta.unit}
                    </div>
                  </span>
                </button>
              );
            })}
          </div>
          {errors.headlineMetrics ? (
            <FieldError>{errors.headlineMetrics}</FieldError>
          ) : (
            <FieldHint>
              Free-form keys are blocked. Add to the canonical dictionary first.
            </FieldHint>
          )}
        </Panel>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          type="button"
          onClick={() => router.push("/admin")}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "new"
            ? "Save security"
            : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function ChipInput({
  values,
  input,
  onInput,
  onAdd,
  onRemove,
  placeholder,
}: {
  values: string[];
  input: string;
  onInput: (s: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
        />
        <Button
          type="button"
          size="md"
          variant="secondary"
          leadingIcon={<Plus size={12} />}
          onClick={onAdd}
        >
          Add
        </Button>
      </div>
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex h-[24px] items-center gap-1 rounded-[5px] border border-bd2 bg-s3 px-2 text-[11.5px] text-tx"
            >
              {v}
              <button
                type="button"
                onClick={() => onRemove(v)}
                className="text-tx-mid hover:text-danger"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
