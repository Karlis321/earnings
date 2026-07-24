"use client";

// Custom Sources. Discover input, kind detection UI, scope selector, list/toggle/remove.
// Backend integration flag (P8-T4): /api/discover-feed + /api/shared-state.

import { useState } from "react";
import { data } from "@/lib/data";
import { api } from "@/lib/apiClient";
import {
  Button,
  Input,
  Label,
  FieldHint,
  Panel,
  ProvenanceChip,
} from "@/components/primitives";
import type { DiscoverFeedResult } from "@/lib/types";
import { Rss, Twitter, Globe, X } from "lucide-react";
import { useToast } from "@/providers/ToastProvider";

export default function CustomSourcesPage() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<DiscoverFeedResult | null>(null);
  const [scope, setScope] = useState<string[]>([]);
  const [scopeInput, setScopeInput] = useState("");
  const sources = data.getSharedState().customSources;
  const { push } = useToast();

  const discover = async () => {
    if (!url.trim()) return;
    const r = await api.discoverFeed(url.trim());
    setResult(r);
  };

  const save = () => {
    if (!result) return;
    push({
      kind: "info",
      message: "Saved locally · commit needs backend shared-state write",
    });
    setUrl("");
    setResult(null);
    setScope([]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
          Custom sources
        </h1>
        <p className="mt-1 text-[13.5px] text-tx-mid">
          Add Substacks, X accounts, RSS feeds, or publisher URLs. Kind is
          auto-detected; you set the scope.
        </p>
      </div>

      <Panel eyebrow="Discover source">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <Label>Paste a URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://coppercompendium.substack.com"
            />
            <FieldHint>
              Substack / X / RSS / publisher — Discover picks the right path.
            </FieldHint>
          </div>
          <div className="pt-6">
            <Button size="md" onClick={discover}>
              Discover
            </Button>
          </div>
        </div>

        {result ? (
          <div className="mt-4 rounded-panel border border-bd2 bg-s2 p-4">
            <div className="mb-2 flex items-center gap-2">
              {result.kind === "rss" ? (
                <Rss size={14} className="text-warning" />
              ) : result.kind === "twitter" ? (
                <Twitter size={14} className="text-social-fg" />
              ) : (
                <Globe size={14} className="text-brand-fg" />
              )}
              <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-tx3">
                {result.kind}
              </span>
              <span className="text-[13px] text-tx">{result.title}</span>
              {result.kind === "rejected" ? (
                <span className="ml-auto rounded-[4px] bg-[rgba(248,113,113,0.12)] px-2 py-[1px] text-[11px] text-danger">
                  Rejected
                </span>
              ) : null}
            </div>
            <div className="break-all font-mono text-[11.5px] text-tx-mid">
              {result.url}
            </div>
            {result.note ? (
              <div className="mt-2 text-[12.5px] text-tx-mid">{result.note}</div>
            ) : null}
            {result.kind !== "rejected" && (
              <div className="mt-4 border-t border-bd pt-4">
                <Label>Scope · tickers or themes</Label>
                <div className="flex gap-2">
                  <Input
                    value={scopeInput}
                    onChange={(e) => setScopeInput(e.target.value)}
                    placeholder="INTC US, copper, semiconductors"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && scopeInput.trim()) {
                        e.preventDefault();
                        setScope([...scope, scopeInput.trim()]);
                        setScopeInput("");
                      }
                    }}
                  />
                  <Button size="md" variant="secondary" onClick={save}>
                    Save source
                  </Button>
                </div>
                {scope.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {scope.map((s) => (
                      <span
                        key={s}
                        className="inline-flex h-[22px] items-center gap-1 rounded-[5px] border border-bd2 bg-s3 px-2 text-[11px] text-tx"
                      >
                        {s}
                        <button
                          onClick={() =>
                            setScope(scope.filter((x) => x !== s))
                          }
                          className="text-tx-mid hover:text-danger"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </Panel>

      <Panel eyebrow={`Active custom sources · ${sources.length}`} padded={false}>
        <div className="divide-y divide-bd">
          {sources.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 px-5 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-tx3">
                  {s.kind}
                </span>
                <span className="text-[13px] text-tx">{s.title}</span>
                <span className="font-mono text-[11px] text-tx-mid">
                  {s.url}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {s.scope.tickers.map((t) => (
                  <ProvenanceChip key={t} provenance="ir-page" />
                ))}
                <button
                  className="text-[12px] text-tx3 hover:text-danger"
                  onClick={() =>
                    push({
                      kind: "info",
                      message: "Removed locally · commit needs backend",
                    })
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
