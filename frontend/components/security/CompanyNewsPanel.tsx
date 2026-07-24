"use client";

// Company-scoped news panel — fetches /api/news?q=<display_name>.
// Shown on the security detail page, filters the 30-source RSS fan-out
// to just items mentioning the company.

import { useEffect, useState } from "react";
import { Panel } from "@/components/primitives";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { fmtRelative } from "@/lib/format";
import { Loader2, AlertTriangle, RefreshCw, Newspaper } from "lucide-react";

interface NewsItem {
  headline: string;
  url: string;
  source: string;
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
  displayName: string;
  aliases: string[];
  limit?: number;
}

export function CompanyNewsPanel({ displayName, aliases, limit = 12 }: Props) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { openSource } = useSourceViewer();

  const load = () => {
    setLoading(true);
    setErr(null);
    // Query by display name first — most specific match. Backend does a
    // substring match on headline+source across the whole fanout.
    const q = displayName;
    fetch(`/api/news?q=${encodeURIComponent(q)}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<NewsPayload>;
      })
      .then((j) => {
        // Client-side aliases filter — anything containing an alias or the
        // display name (case-insensitive) counts. Prevents an over-broad
        // substring hit like "Copper" from returning irrelevant items.
        const needles = [displayName, ...aliases]
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length >= 3);
        const scored = j.items.filter((it) => {
          const h = it.headline.toLowerCase();
          return needles.some((n) => h.includes(n));
        });
        setItems(scored.slice(0, limit));
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [displayName]);

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
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-[13px] text-tx-mid">
          <Loader2 size={13} className="animate-spin" />
          Searching news for {displayName}…
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
                    headline: it.headline,
                    source: it.source,
                    provenance:
                      it.category === "wire"
                        ? "wire"
                        : it.category === "central-bank"
                        ? "regulatory"
                        : "news",
                    time: it.time ?? new Date().toISOString(),
                    articleType: it.category === "analysis" ? "opinion" : "news",
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
                {it.headline}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-tx-mid">
                <span className="font-medium text-brand-fg">{it.source}</span>
                <span>·</span>
                <span>{CATEGORY_LABELS[it.category] ?? it.category}</span>
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
