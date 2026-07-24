"use client";

import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { SlideOver } from "@/components/primitives/SlideOver";
import { ProvenanceChip } from "@/components/primitives/ProvenanceChip";
import { Button } from "@/components/primitives/Button";
import { ExternalLink, AlertTriangle, FileText } from "lucide-react";
import { useState } from "react";
import { Modal } from "@/components/primitives/Modal";

// Source / Deep-Link viewer (FE PRD §7.7).
// Hosted mode = anchor highlight in a rendered document (backend integration
// flag: needs hosted Document/Segment content from /api/earnings).
// Link-out mode = confirmation dialog → new tab (works on fixtures now).

export function SourceViewer() {
  const { open, close } = useSourceViewer();
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);

  const hosted =
    open?.kind === "item" ? open.item.hosted : false;

  const url =
    open?.kind === "item" ? open.item.url : open?.source.url ?? "";
  const label =
    open?.kind === "item" ? open.item.source : open?.source.label ?? "";
  const provenance =
    open?.kind === "item" ? open.item.provenance : open?.source.provenance;
  const title =
    open?.kind === "item" ? open.item.headline : "Fact source";

  const openExternal = () => {
    setConfirmUrl(url);
  };

  return (
    <>
      <SlideOver
        open={!!open}
        onOpenChange={(v) => !v && close()}
        eyebrow="Source viewer"
        title={title}
        width={720}
      >
        {open ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {provenance ? <ProvenanceChip provenance={provenance} /> : null}
              <span className="font-mono text-[11.5px] text-tx-mid">
                {label}
              </span>
              <span className="ml-auto flex items-center gap-2">
                {hosted ? (
                  <span className="rounded-[5px] border border-bd2 bg-s3 px-2 py-[3px] font-mono text-[10.5px] uppercase text-tx2">
                    Hosted
                  </span>
                ) : (
                  <span className="rounded-[5px] border border-bd2 bg-s3 px-2 py-[3px] font-mono text-[10.5px] uppercase text-tx2">
                    Link-out
                  </span>
                )}
              </span>
            </div>

            {hosted ? (
              <HostedFallback />
            ) : (
              <div className="rounded-panel border border-bd bg-s1 p-6">
                <div className="mono-eyebrow mb-3">Original article</div>
                <div className="mb-4 text-[14px] leading-[1.6] text-tx-strong">
                  This item lives on{" "}
                  <span className="font-mono text-brand-fg">{label}</span>. Open
                  the publisher to read the full text.
                </div>
                <Button
                  onClick={openExternal}
                  leadingIcon={<ExternalLink size={13} />}
                >
                  Open at publisher
                </Button>
              </div>
            )}

            <div className="rounded-panel border border-bd bg-panel p-4 text-[12px] text-tx-mid">
              <div className="mono-eyebrow mb-2">URL</div>
              <div className="break-all font-mono text-[11.5px] text-tx-strong">
                {url}
              </div>
            </div>
          </div>
        ) : null}
      </SlideOver>

      <Modal
        open={!!confirmUrl}
        onOpenChange={(v) => !v && setConfirmUrl(null)}
        title="Opening an external site"
        description="You are about to leave Signal and open a third-party publisher in a new tab."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmUrl(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                window.open(confirmUrl ?? "#", "_blank", "noopener,noreferrer");
                setConfirmUrl(null);
              }}
              leadingIcon={<ExternalLink size={13} />}
            >
              Open in new tab
            </Button>
          </>
        }
      >
        <div className="break-all rounded-panel border border-bd bg-s3 p-3 font-mono text-[11.5px] text-tx-strong">
          {confirmUrl}
        </div>
      </Modal>
    </>
  );
}

function HostedFallback() {
  // Hosted mode requires backend Document/Segment content — show the fallback
  // per FE PRD §7.7: "hosted needs backend content".
  return (
    <div className="rounded-panel border border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.05)] p-6">
      <div className="mb-3 flex items-center gap-2 text-warning">
        <AlertTriangle size={14} />
        <span className="font-mono text-[11px] uppercase tracking-[0.12em]">
          Anchor highlight unavailable · fixture mode
        </span>
      </div>
      <div className="text-[13.5px] text-tx-strong">
        Hosted document rendering requires the backend to serve segmented
        transcript/filing content. Falling back to link-out.
      </div>
      <div className="mt-3 rounded-card border border-bd bg-s1 p-4">
        <div className="mono-eyebrow mb-2 flex items-center gap-2">
          <FileText size={12} /> Sample segment
        </div>
        <p className="text-[13.5px] leading-[1.65] text-tx">
          &ldquo;Our full-year revenue outlook now sits at $62 to $65 billion,
          raising the midpoint from the range we shared in April. Data-center
          gross margin expanded 340 basis points sequentially, driven by
          Sapphire Rapids ramp.&rdquo;
        </p>
        <div className="mt-2 font-mono text-[11px] text-tx3">
          Speaker: David Zinsner, CFO · para-4
        </div>
      </div>
    </div>
  );
}
