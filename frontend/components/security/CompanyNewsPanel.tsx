"use client";

// Company-scoped news panel — fetches /api/news?q=<display_name>.
// Shown on the security detail page, filters the 30-source RSS fan-out
// to just items mentioning the company.

import { useEffect, useState } from "react";
import { Panel } from "@/components/primitives";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { fmtRelative } from "@/lib/format";
import { AlertTriangle, RefreshCw, Newspaper } from "lucide-react";
import { LoadingSpinner } from "@/components/primitives/LoadingSpinner";

interface NewsItem {
  // v2 shape (post-normalizer):
  title?: string;
  publisher?: string;
  articleType?: "news" | "opinion";
  // v1 shape (retained for backward compat with any pre-normalizer
  // cached responses; normalizer emits `title`/`publisher`, older
  // fetches emit `headline`/`source`):
  headline?: string;
  source?: string;
  url: string;
  category: string;
  time: string | null;
}
interface NewsPayload {
  fetchedAt: string;
  items: NewsItem[];
}

const CATEGORY_LABELS: Record<string, string> = {
  wire: "Wire",
  analysis: "Analysis",
  mining: "Mining",
  defense: "Defense",
  energy: "Energy",
  asia: "Asia",
  eu: "EU",
  "central-bank": "Central bank",
};

interface Props {
  ticker: string;
  displayName: string;
  aliases?: string[];
  limit?: number;
}

export function CompanyNewsPanel({ ticker, displayName, limit = 12 }: Props) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { openSource } = useSourceViewer();

  const load = () => {
    setLoading(true);
    setErr(null);
    // New endpoint contract: /api/news?ticker=<bloomberg> runs a targeted
    // Google-News RSS OR-query over the entity's aliases + cashtag +
    // Yahoo-suffix forms (via fetchEntityNews) instead of the strict
    // .includes(displayName) pre-filter. Server already returns fully
    // filtered items, so no client-side alias re-filter needed.
    fetch(`/api/news?ticker=${encodeURIComponent(ticker)}&days=14`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<NewsPayload>;
      })
      .then((j) => setItems((j.items ?? []).slice(0, limit)))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [ticker]);

  return (
    <Panel
      eyebrow={`News · ${displayName}`}
      padded={false}
    >
      <div className="flex items-center justify-between border-b border-bd px-4 py-2 text-[12px] text-tx-mid">
        <span>Filtered across 30+ RSS sources</span>
        <button
          onClick={load}
          className="inline-flex items-center gap-[6px] rounded-button border border-bd bg-s1 px-2 py-[3px] text-[11.5px] text-tx2 hover:text-tx"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center px-4 py-8">
          <LoadingSpinner
            label={`Searching news for ${displayName}…`}
            size="sm"
          />
        </div>
      ) : err ? (
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-[13px] text-danger">
          <AlertTriangle size={13} />
          Failed: {err}
        </div>
      ) : !items || items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-tx-mid">
          <Newspaper size={20} className="text-tx-faint" />
          <div className="text-[13px]">
            No recent news mentioning {displayName}.
          </div>
          <div className="max-w-[42ch] text-[11.5px] text-tx3">
            Coverage comes from Reuters, AP, FT, Bloomberg, WSJ, Economist,
            mining + defense + energy + central-bank RSS.
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-bd">
          {items.map((it, i) => (
            <li
              key={i}
              onClick={() =>
                openSource({
                  kind: "item",
                  item: {
                    id: `cn-${i}`,
                    url: it.url,
                    headline: it.title ?? it.headline ?? "(untitled)",
                    source: it.publisher ?? it.source ?? "?",
                    provenance:
                      it.category === "wire"
                        ? "wire"
                        : it.category === "central-bank"
                        ? "regulatory"
                        : "news",
                    time: it.time ?? new Date().toISOString(),
                    articleType: it.articleType ?? (it.category === "analysis" ? "opinion" : "news"),
                    engine: "google",
                    language: "en",
                    hosted: false,
                    summary: null,
                  },
                })
              }
              className="cursor-pointer px-4 py-3 transition-colors hover:bg-hover"
            >
              <div className="text-[13.5px] font-medium leading-[1.35] text-tx">
                {it.title ?? it.headline ?? "(untitled)"}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-tx-mid">
                <span className="font-medium text-brand-fg">
                  {it.publisher ?? it.source ?? "?"}
                </span>
                {it.articleType === "opinion" ? (
                  <>
                    <span>·</span>
                    <span className="text-tx3">opinion</span>
                  </>
                ) : null}
                <span>·</span>
                <span>{fmtRelative(it.time)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
