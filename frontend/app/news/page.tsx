"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/primitives";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { fmtRelative } from "@/lib/format";
import { Loader2, RefreshCw } from "lucide-react";
import clsx from "clsx";

interface NewsItem {
  headline: string;
  url: string;
  source: string;
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

export default function NewsPage() {
  const [data, setData] = useState<NewsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>("all");
  const { openSource } = useSourceViewer();

  const load = async (q?: string) => {
    setLoading(true);
    setErr(null);
    try {
      const path = q ? `/api/news?q=${encodeURIComponent(q)}` : "/api/news";
      const r = await fetch(path, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status}`);
      setData((await r.json()) as NewsPayload);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load(query || undefined);
          }}
          className="flex items-center gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by keyword…"
            className="h-9 w-[260px] rounded-button border border-bd2 bg-s1 px-3 text-[13.5px] text-tx outline-none focus:border-brand focus:shadow-[0_0_0_3px_rgba(47,127,255,0.18)]"
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
          {filtered.map((it, i) => (
            <article
              key={i}
              className="cursor-pointer rounded-panel border border-bd bg-s1 p-4 transition-colors hover:bg-hover"
              onClick={() =>
                openSource({
                  kind: "item",
                  item: {
                    id: `n-${i}`,
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
            >
              <div className="mb-2 text-[14px] font-medium leading-[1.4] text-tx">
                {it.headline}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-tx-mid">
                <span className="font-medium text-brand-fg">{it.source}</span>
                <span>·</span>
                <span>{CATEGORY_LABELS[it.category] ?? it.category}</span>
                <span>·</span>
                <span>{fmtRelative(it.time)}</span>
              </div>
            </article>
          ))}
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
