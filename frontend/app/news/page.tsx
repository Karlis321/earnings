"use client";
// v2-shape read path (title/publisher with v1 headline/source fallback) —
// see dfebd110f. This comment is here to invalidate the Vercel build
// cache's content-hash for this file after the previous deploy failed
// to pick up the earlier edit.

import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/primitives";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { fmtRelative } from "@/lib/format";
import { Loader2, RefreshCw } from "lucide-react";
import {
  ShareEmailButton,
  shareArticleProps,
} from "@/components/primitives/ShareEmailButton";
import { BasketToggle } from "@/components/primitives/BasketToggle";
import clsx from "clsx";

// /api/news emits the v2 normalized shape (title/publisher) since the
// newsNormalize.ts refactor; older cached responses may still emit
// v1 (headline/source). Support both so the rendering never renders
// an undefined title slot when the boundary catches a stale response.
interface NewsItem {
  // v2 shape (current):
  title?: string;
  publisher?: string;
  articleType?: "news" | "opinion";
  // v1 shape (retained for pre-normalizer fetches):
  headline?: string;
  source?: string;
  // shared fields:
  url: string;
  category: string;
  time: string | null;
}
interface Engine {
  source: string;
  category: string;
  ok: boolean;
  itemsFound: number;
}
interface NewsPayload {
  fetchedAt: string;
  items: NewsItem[];
  engineStatus: Engine[];
  categories: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  wire: "Wire (Reuters, AP, FT, Bloomberg, WSJ)",
  analysis: "Analysis (Economist)",
  mining: "Mining & metals",
  defense: "Defense",
  energy: "Energy & nuclear",
  asia: "Asia / EM",
  eu: "Europe policy",
  "central-bank": "Central banks",
};

const DAY_WINDOWS: Array<{ id: number; label: string }> = [
  { id: 1, label: "1d" },
  { id: 7, label: "7d" },
  { id: 30, label: "30d" },
  { id: 90, label: "90d" },
];

export default function NewsPage() {
  const [data, setData] = useState<NewsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>("all");
  const [days, setDays] = useState<number>(7);
  const { openSource } = useSourceViewer();

  const load = async (q?: string, d = days) => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("days", String(d));
      const r = await fetch(`/api/news?${params}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status}`);
      setData((await r.json()) as NewsPayload);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(query || undefined, days);
  }, [days]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (active === "all") return data.items;
    return data.items.filter((i) => i.category === active);
  }, [data, active]);

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="mono-eyebrow mb-3">§ News · live fan-out</div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
            News across 30+ sources
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-button border border-bd bg-s2 p-[3px]">
            {DAY_WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setDays(w.id)}
                className={
                  days === w.id
                    ? "rounded-[6px] bg-brand px-3 py-[5px] text-[12px] font-medium text-white"
                    : "rounded-[6px] px-3 py-[5px] text-[12px] text-tx2 hover:text-tx"
                }
              >
                {w.label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              load(query || undefined, days);
            }}
            className="flex items-center gap-2"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by keyword…"
              className="h-9 w-[240px] rounded-button border border-bd2 bg-s1 px-3 text-[13.5px] text-tx outline-none focus:border-brand focus:shadow-[0_0_0_3px_rgba(47,127,255,0.18)]"
            />
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-2 rounded-button bg-brand px-3 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </form>
        </div>
      </div>

      {/* Category tabs */}
      <div className="mb-4 flex flex-wrap gap-2">
        <TabBtn
          label={`All · ${data?.items.length ?? "…"}`}
          active={active === "all"}
          onClick={() => setActive("all")}
        />
        {(data?.categories ?? []).map((c) => {
          const count = data?.items.filter((i) => i.category === c).length ?? 0;
          return (
            <TabBtn
              key={c}
              label={`${CATEGORY_LABELS[c] ?? c} · ${count}`}
              active={active === c}
              onClick={() => setActive(c)}
            />
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-tx-mid">
          <Loader2 size={14} className="animate-spin" />
          Fanning out to 30+ RSS sources…
        </div>
      ) : err ? (
        <Panel eyebrow="Error">
          <div className="text-danger text-[13px]">Failed: {err}</div>
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {filtered.map((it, i) => {
            // Read v2 fields with v1 fallback so both API shapes render.
            const headline = it.title ?? it.headline ?? "(untitled)";
            const source = it.publisher ?? it.source ?? "unknown";
            return (
            <article
              key={i}
              className="cursor-pointer rounded-panel border border-bd bg-s1 p-4 transition-colors hover:bg-hover"
              onClick={() =>
                openSource({
                  kind: "item",
                  item: {
                    id: `n-${i}`,
                    url: it.url,
                    headline,
                    source,
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
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="text-[14px] font-medium leading-[1.4] text-tx">
                  {headline}
                </div>
                <BasketToggle
                  id={`news-${it.url}`}
                  headline={headline}
                  url={it.url}
                  source={source}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-tx-mid">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-brand-fg">{source}</span>
                  <span>·</span>
                  <span>{CATEGORY_LABELS[it.category] ?? it.category}</span>
                  <span>·</span>
                  <span>{fmtRelative(it.time)}</span>
                </div>
                <ShareEmailButton
                  {...shareArticleProps(headline, it.url, source)}
                  variant="ghost"
                  label="Share now"
                />
              </div>
            </article>
          );
          })}
          {filtered.length === 0 && (
            <div className="col-span-full p-8 text-center text-[13px] text-tx-mid">
              No items {query ? `matching "${query}"` : ""} in this category.
            </div>
          )}
        </div>
      )}

      {/* Engine status footer */}
      {data ? (
        <div className="mt-6">
          <div className="mono-eyebrow mb-2">Source status</div>
          <div className="flex flex-wrap gap-2">
            {data.engineStatus.map((es) => (
              <span
                key={es.source}
                className={clsx(
                  "inline-flex h-[22px] items-center gap-[6px] rounded-[5px] border px-[9px] text-[10.5px]",
                  es.ok
                    ? "border-bd2 bg-s3 text-tx-mid"
                    : "border-[rgba(180,35,24,0.28)] bg-[rgba(180,35,24,0.06)] text-danger",
                )}
              >
                <span
                  className="inline-block h-[6px] w-[6px] rounded-full"
                  style={{
                    background: es.ok ? "var(--success)" : "var(--danger)",
                  }}
                />
                {es.source}
                <span className="text-tx3">· {es.itemsFound}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "rounded-button border px-3 py-[6px] text-[12.5px] transition-colors",
        active
          ? "border-brand bg-brand/10 font-medium text-brand-fg"
          : "border-bd bg-s1 text-tx2 hover:bg-hover hover:text-tx",
      )}
    >
      {label}
    </button>
  );
}
