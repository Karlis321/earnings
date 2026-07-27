"use client";

// Expand watchlist. Screener → candidate grid → per-row add to coverage.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Input,
  Label,
  FieldHint,
  Panel,
  TypeBadge,
} from "@/components/primitives";
import { api, ApiError } from "@/lib/apiClient";
import { useToast } from "@/providers/ToastProvider";
import { usePersistence } from "@/providers/PersistenceProvider";
import { capTierLabel } from "@/lib/capTier";
import type { CapTier, Entity, SecurityType } from "@/lib/types";
import { RefreshCw, Plus } from "lucide-react";

interface Candidate {
  yahooSymbol: string;
  suggestedTicker: string;
  name: string;
  exchange: string;
  currency: string | null;
  marketCapUsd: number | null;
  marketCapAsOf: string;
  capTier: CapTier;
  sector: string | null;
  industry: string | null;
  suggestedSectorTags: string[];
  suggestedSecurityType: SecurityType;
  region: string | null;
}

interface Response {
  hits: Candidate[];
  total: number;
  filteredExisting: number;
  asOf: string;
}

function formatCap(usd: number | null): string {
  if (usd == null) return "—";
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(2)}T`;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(0)}M`;
  return `$${usd}`;
}

const SECTORS = [
  { id: "technology", label: "Technology" },
  { id: "materials", label: "Materials" },
  { id: "energy", label: "Energy" },
  { id: "etfs", label: "ETFs" },
  { id: "developer", label: "Developers (pre-rev mining)" },
  { id: "any", label: "Any" },
];

const TIERS: Array<{ id: CapTier | "any"; label: string }> = [
  { id: "any", label: "Any size" },
  { id: "mega", label: capTierLabel("mega") },
  { id: "large", label: capTierLabel("large") },
  { id: "mid", label: capTierLabel("mid") },
  { id: "small", label: capTierLabel("small") },
];

const REGIONS = [
  { id: "us", label: "United States" },
  { id: "ca", label: "Canada" },
  { id: "gb", label: "United Kingdom" },
  { id: "de", label: "Germany" },
  { id: "fr", label: "France" },
  { id: "any", label: "Any" },
];

export default function ExpandPage() {
  const router = useRouter();
  const { push } = useToast();
  const { markSyncing, markSynced, markLocal } = usePersistence();
  const [sector, setSector] = useState("technology");
  const [tier, setTier] = useState<CapTier | "any">("large");
  const [count, setCount] = useState(50);
  const [region, setRegion] = useState("us");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Response | null>(null);
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<Record<string, true>>({});

  const discover = async () => {
    if (loading) return;
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch("/api/expand-watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sector, capTier: tier, count, region }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message ?? `HTTP ${r.status}`);
      }
      setResult((await r.json()) as Response);
    } catch (e) {
      push({ kind: "danger", message: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const addOne = async (c: Candidate) => {
    if (adding[c.suggestedTicker] || added[c.suggestedTicker]) return;
    setAdding((s) => ({ ...s, [c.suggestedTicker]: true }));
    markSyncing();
    try {
      const patch: Partial<Entity> = {
        ticker: c.suggestedTicker,
        displayName: c.name.split(",")[0].split(" Inc")[0].trim() || c.name,
        legalName: c.name,
        securityType: c.suggestedSecurityType,
        listing: c.exchange,
        currency: c.currency ?? "USD",
        benchmark: c.suggestedSecurityType === "developer" ? "" : "SPX",
        aliases: [c.name],
        exclusionAliases: [],
        sectorTags: c.suggestedSectorTags,
        headlineMetrics:
          c.suggestedSecurityType === "operating" ? ["revenue_usd_m", "eps_usd"] : [],
        cashtag: c.yahooSymbol.split(".")[0] || null,
        isCore: false, // added-from-screener defaults to headline coverage
        coverage: "headline",
        catalystTypes:
          c.suggestedSecurityType === "developer" ? ["Drill Result"] : [],
        marketCapUsd: c.marketCapUsd,
        marketCapAsOf: c.marketCapAsOf,
        capTier: c.capTier,
      };
      await api.postEntity(patch);
      setAdded((s) => ({ ...s, [c.suggestedTicker]: true }));
      markSynced();
      push({ kind: "success", message: `Added ${c.suggestedTicker}` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        markLocal();
        push({
          kind: "warning",
          message: "Local only — set GH_PAT to enable writes",
        });
      } else if (e instanceof ApiError && e.status === 409) {
        markSynced();
        setAdded((s) => ({ ...s, [c.suggestedTicker]: true }));
        push({ kind: "info", message: `${c.suggestedTicker} already exists` });
      } else {
        markSynced();
        push({ kind: "danger", message: (e as Error).message });
      }
    } finally {
      setAdding((s) => ({ ...s, [c.suggestedTicker]: false }));
      router.refresh();
    }
  };

  const addAll = async () => {
    if (!result) return;
    for (const c of result.hits) {
      if (added[c.suggestedTicker]) continue;
      await addOne(c);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
          Expand watchlist
        </h1>
        <p className="mt-1 text-[13.5px] text-tx-mid">
          Yahoo screener ranked by market cap. Pick a sector + size, review the
          candidates, add the ones you want. Existing coverage is filtered out
          automatically.
        </p>
      </div>

      <Panel eyebrow="Screen">
        <div className="grid grid-cols-[1fr_1fr_120px_140px_auto] gap-3">
          <div>
            <Label>Sector</Label>
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
            >
              {SECTORS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Cap tier</Label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as CapTier | "any")}
              className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
            >
              {TIERS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Count</Label>
            <Input
              type="number"
              value={count}
              onChange={(e) => setCount(Math.min(250, Math.max(1, Number(e.target.value) || 50)))}
              mono
            />
          </div>
          <div>
            <Label>Region</Label>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="h-9 w-full rounded-button border border-bd2 bg-s2 px-3 text-[13.5px] text-tx"
            >
              {REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <Button onClick={discover} disabled={loading}>
              {loading ? (
                <>
                  <RefreshCw size={12} className="mr-1 animate-spin" />
                  Discovering…
                </>
              ) : (
                "Discover"
              )}
            </Button>
          </div>
        </div>
        <FieldHint>
          Developer slice screens Basic Materials with a $2B cap ceiling — pre-
          revenue miners typically sit below that.
        </FieldHint>
      </Panel>

      {result ? (
        <Panel
          eyebrow={
            `Candidates · ${result.hits.length} new` +
            (result.filteredExisting > 0
              ? ` · ${result.filteredExisting} already covered filtered`
              : "") +
            ` · universe ${result.total}`
          }
          padded={false}
        >
          <div className="flex items-center justify-between border-b border-bd px-5 py-3">
            <span className="font-mono text-[11px] text-tx-mid">
              As of {result.asOf}
            </span>
            <Button size="sm" variant="secondary" onClick={addAll}>
              Add all ({result.hits.length})
            </Button>
          </div>
          <div className="grid grid-cols-[1.4fr_120px_1fr_120px_auto] items-center gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
            <span>Name · Ticker</span>
            <span>Cap · Tier</span>
            <span>Sector · Industry</span>
            <span>Exchange</span>
            <span className="w-[110px]" />
          </div>
          {result.hits.map((c) => (
            <div
              key={c.suggestedTicker}
              className="grid grid-cols-[1.4fr_120px_1fr_120px_auto] items-center gap-3 border-b border-bd px-4 py-3 text-[12.5px] last:border-b-0"
            >
              <div className="flex flex-col">
                <span className="text-[13px] text-tx">{c.name}</span>
                <span className="font-mono text-[11px] text-brand-fg">
                  {c.suggestedTicker}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="font-mono tabular-nums text-tx">
                  {formatCap(c.marketCapUsd)}
                </span>
                <span className="font-mono text-[10.5px] text-tx-mid">
                  {c.capTier}
                </span>
              </div>
              <div className="flex flex-col text-tx-mid">
                <span className="text-tx">{c.sector ?? "—"}</span>
                <span className="text-[11px] text-tx3">
                  {c.industry ?? "—"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <TypeBadge type={c.suggestedSecurityType} size="sm" />
                <span className="font-mono text-[11px] text-tx-mid">
                  {c.exchange}
                </span>
              </div>
              <div className="flex justify-end">
                {added[c.suggestedTicker] ? (
                  <span className="rounded-[4px] bg-[rgba(18,183,106,0.10)] px-[8px] py-[3px] text-[11px] font-semibold uppercase tracking-[0.08em] text-success-fg">
                    added
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => addOne(c)}
                    disabled={adding[c.suggestedTicker]}
                    leadingIcon={<Plus size={11} />}
                  >
                    {adding[c.suggestedTicker] ? "Adding…" : "Add"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Panel>
      ) : null}
    </div>
  );
}
