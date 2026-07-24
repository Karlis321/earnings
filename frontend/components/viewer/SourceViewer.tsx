"use client";

import { useEffect, useState } from "react";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { SlideOver } from "@/components/primitives/SlideOver";
import { ProvenanceChip } from "@/components/primitives/ProvenanceChip";
import { Button } from "@/components/primitives/Button";
import {
  ExternalLink,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
} from "lucide-react";
import {
  ShareEmailButton,
  shareArticleProps,
} from "@/components/primitives/ShareEmailButton";

// Source viewer with in-app iframe preview.
// Fallback: if the publisher blocks embedding (X-Frame-Options / CSP
// frame-ancestors), we show a "Open at publisher" button.

export function SourceViewer() {
  const { open, close } = useSourceViewer();
  const [iframeStatus, setIframeStatus] = useState<
    "loading" | "ok" | "blocked"
  >("loading");
  const [iframeKey, setIframeKey] = useState(0);

  const url =
    open?.kind === "item" ? open.item.url : open?.source.url ?? "";
  const label =
    open?.kind === "item" ? open.item.source : open?.source.label ?? "";
  const provenance =
    open?.kind === "item" ? open.item.provenance : open?.source.provenance;
  const title =
    open?.kind === "item" ? open.item.headline : "Fact source";

  useEffect(() => {
    if (!open) return;
    setIframeStatus("loading");
    setIframeKey((k) => k + 1);
    // Heuristic: if the iframe hasn't fired `load` in 4s, treat as blocked.
    const t = setTimeout(() => {
      setIframeStatus((s) => (s === "loading" ? "blocked" : s));
    }, 4000);
    return () => clearTimeout(t);
  }, [open, url]);

  const isReal = url && url !== "#" && url.startsWith("http");

  return (
    <SlideOver
      open={!!open}
      onOpenChange={(v) => !v && close()}
      eyebrow="Source preview"
      title={title}
      width={860}
      actions={
        isReal ? (
          <>
            <ShareEmailButton
              {...shareArticleProps(title as string, url, label as string)}
              size="sm"
              variant="outline"
              label="Share via Gmail"
            />
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-2 rounded-button border border-bd2 bg-s1 px-3 text-[12.5px] text-tx hover:bg-s2"
            >
              <ExternalLink size={12} />
              Open at publisher
            </a>
          </>
        ) : null
      }
    >
      {open ? (
        <div className="flex h-full flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<ArrowLeft size={12} />}
              onClick={close}
            >
              Back to dashboard
            </Button>
            {provenance ? <ProvenanceChip provenance={provenance} /> : null}
            <span className="text-[11.5px] text-tx-mid">{label}</span>
          </div>

          {isReal ? (
            <div className="relative flex-1 overflow-hidden rounded-panel border border-bd bg-s1">
              {iframeStatus !== "blocked" ? (
                <>
                  <iframe
                    key={iframeKey}
                    src={url}
                    title={title}
                    className="h-full min-h-[520px] w-full"
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                    onLoad={() => setIframeStatus("ok")}
                    onError={() => setIframeStatus("blocked")}
                  />
                  {iframeStatus === "loading" ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-s1/80 text-[13px] text-tx-mid">
                      <RefreshCw size={14} className="mr-2 animate-spin" />
                      Loading preview…
                    </div>
                  ) : null}
                </>
              ) : (
                <BlockedFallback url={url} label={label} />
              )}
            </div>
          ) : (
            <div className="rounded-panel border border-bd bg-s1 p-6 text-[13.5px] text-tx-mid">
              No URL on file for this source.
            </div>
          )}

          <div className="rounded-panel border border-bd bg-panel2 p-3 font-mono text-[11px] text-tx-mid">
            <div className="mono-eyebrow mb-1">URL</div>
            <div className="break-all text-tx-strong">{url}</div>
          </div>
        </div>
      ) : null}
    </SlideOver>
  );
}

function BlockedFallback({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle size={22} className="text-warning" />
      <div className="max-w-[48ch]">
        <div className="text-[15px] font-semibold text-tx">
          This publisher blocks embedded previews
        </div>
        <p className="mt-2 text-[13px] leading-[1.5] text-tx-mid">
          {label || "The source"} sends an <code>X-Frame-Options</code> or{" "}
          <code>frame-ancestors</code> header that prevents rendering inside
          Signal. Open it at the publisher — the tab stays open so you can
          come back here.
        </p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-9 items-center gap-2 rounded-button bg-brand px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi"
      >
        <ExternalLink size={13} />
        Open at publisher
      </a>
    </div>
  );
}
