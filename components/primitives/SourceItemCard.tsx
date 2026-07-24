"use client";

// $0 mode: NO summary line. Just headline + source + provenance + heuristic
// news/opinion + language, plus (for tweets) engagement counts.

import type { SourceItem } from "@/lib/types";
import { ProvenanceChip } from "./ProvenanceChip";
import { ArticleTypeBadge } from "./ArticleTypeBadge";
import { LanguageBadge } from "./LanguageBadge";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { fmtRelative } from "@/lib/format";
import { Heart, Repeat2, MessageCircle, ThumbsDown, Ban } from "lucide-react";
import { useToast } from "@/providers/ToastProvider";

interface Props {
  item: SourceItem;
  showFeedback?: boolean;
}

export function SourceItemCard({ item, showFeedback = false }: Props) {
  const { openSource } = useSourceViewer();
  const { push } = useToast();
  return (
    <article className="group rounded-panel border border-bd bg-s1 p-4 transition-colors hover:bg-hover">
      <button
        className="mb-[10px] block w-full text-left text-[14px] font-medium leading-[1.4] text-tx hover:text-brand-hi"
        onClick={() => openSource({ kind: "item", item })}
      >
        {item.headline}
      </button>

      {/* $0 mode: summary line intentionally omitted */}

      <div className="mb-[10px] flex flex-wrap gap-[6px]">
        <ProvenanceChip provenance={item.provenance} />
        <ArticleTypeBadge type={item.articleType} />
        <LanguageBadge lang={item.language} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 font-mono text-[11.5px] text-tx-mid">
          <span>{item.source}</span>
          <span aria-hidden="true">·</span>
          <span>{fmtRelative(item.time)}</span>
          <span className="rounded-[4px] bg-s3 px-[5px] py-[1px] text-[10px] uppercase tracking-[0.06em] text-tx3">
            {item.engine}
          </span>
        </div>
        <button
          onClick={() => openSource({ kind: "item", item })}
          className="text-[12px] text-brand-hi hover:text-brand-fg"
        >
          View source →
        </button>
      </div>

      {item.engagement ? (
        <div className="mt-3 flex items-center gap-4 border-t border-bd pt-3 font-mono text-[11.5px] text-tx-mid">
          <span className="flex items-center gap-[6px]">
            <Heart size={11} /> {item.engagement.likes}
          </span>
          <span className="flex items-center gap-[6px]">
            <Repeat2 size={11} /> {item.engagement.reposts}
          </span>
          <span className="flex items-center gap-[6px]">
            <MessageCircle size={11} /> {item.engagement.replies}
          </span>
        </div>
      ) : null}

      {showFeedback ? (
        <div className="mt-3 flex items-center gap-2 border-t border-bd pt-3">
          <button
            className="rounded-[5px] border border-bd2 bg-s2 px-2 py-1 text-[11px] text-tx-mid hover:text-tx"
            onClick={() =>
              push({ kind: "info", message: "Marked not-relevant · local" })
            }
          >
            <ThumbsDown size={11} className="mr-1 inline" /> not relevant
          </button>
          <button
            className="rounded-[5px] border border-bd2 bg-s2 px-2 py-1 text-[11px] text-tx-mid hover:text-tx"
            onClick={() =>
              push({ kind: "info", message: "Source blocked · local" })
            }
          >
            <Ban size={11} className="mr-1 inline" /> block source
          </button>
        </div>
      ) : null}
    </article>
  );
}
