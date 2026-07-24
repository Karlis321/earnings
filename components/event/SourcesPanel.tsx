"use client";

import { useMemo, useState } from "react";
import type { EventRecord, Provenance } from "@/lib/types";
import {
  SourceItemCard,
  SourceUnavailableChip,
  Panel,
  Button,
} from "@/components/primitives";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useToast } from "@/providers/ToastProvider";
import clsx from "clsx";

type Tab = "all" | "official" | "news" | "opinion" | "social";

// P6-T4 sources panel. Group tabs, per-engine status, refresh (backend flag).

export function SourcesPanel({ event }: { event: EventRecord }) {
  const [tab, setTab] = useState<Tab>("all");
  const [refreshing, setRefreshing] = useState(false);
  const { push } = useToast();

  const groups = useMemo(() => {
    const items = event.sources.items;
    return {
      all: items,
      official: items.filter(
        (i) => i.provenance === "ir-page" || i.provenance === "regulatory",
      ),
      news: items.filter(
        (i) =>
          (i.provenance === "wire" || i.provenance === "news") &&
          i.articleType === "news",
      ),
      opinion: items.filter((i) => i.articleType === "opinion"),
      social: items.filter((i) => i.provenance === "social"),
    };
  }, [event.sources.items]);

  const active = groups[tab];

  return (
    <Panel
      eyebrow={`Sources · window ${event.sources.windowStart} → ${event.sources.windowEnd}`}
      padded={false}
    >
      <div className="flex items-center justify-between border-b border-bd px-5 py-3">
        <div className="flex gap-4">
          {(["all", "official", "news", "opinion", "social"] as Tab[]).map(
            (t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  "border-b-2 pb-2 text-[13px] capitalize transition-colors",
                  tab === t
                    ? "border-brand font-medium text-tx"
                    : "border-transparent text-tx2 hover:text-tx",
                )}
              >
                {t}{" "}
                <span className="ml-1 font-mono text-[11px] text-tx3">
                  {groups[t].length}
                </span>
              </button>
            ),
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<RefreshCw size={12} />}
          loading={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await api.refreshSources(event.id);
              push({
                kind: "info",
                message: "Fixture mode · live refresh needs backend /api/news, /api/press-releases, /api/tweets",
              });
            } finally {
              setRefreshing(false);
            }
          }}
        >
          Refresh sources
        </Button>
      </div>

      {/* Per-engine status row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-bd bg-panel2 px-5 py-[10px]">
        {event.sources.engineStatus.map((es) =>
          es.ok ? (
            <span
              key={es.engine}
              className="inline-flex h-[22px] items-center gap-[6px] rounded-[5px] border border-bd2 bg-s3 px-[9px] font-mono text-[10.5px] text-tx-mid"
            >
              <span className="h-[6px] w-[6px] rounded-full bg-success" />
              {es.engine}
            </span>
          ) : (
            <SourceUnavailableChip
              key={es.engine}
              engine={es.engine}
              reason={es.engine === "twitter" ? "proxy down" : "fetch failed"}
              lastGood={es.lastGood}
            />
          ),
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 p-5 md:grid-cols-2">
        {active.length === 0 ? (
          <div className="col-span-full flex flex-col items-center gap-2 p-8 text-center">
            <div className="text-[13.5px] text-tx-mid">
              No items in this group yet.
            </div>
            <div className="font-mono text-[11px] text-tx-faint">
              window still accruing · captured{" "}
              {event.sources.capturedAt ?? "never"}
            </div>
          </div>
        ) : (
          active.map((it) => (
            <SourceItemCard key={it.id} item={it} showFeedback />
          ))
        )}
      </div>
    </Panel>
  );
}
