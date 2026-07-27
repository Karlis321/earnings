"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { EventRecord, Provenance } from "@/lib/types";
import {
  SourceItemCard,
  SourceUnavailableChip,
  Panel,
  Button,
} from "@/components/primitives";
import { RefreshCw } from "lucide-react";
import { api, ApiError } from "@/lib/apiClient";
import { useToast } from "@/providers/ToastProvider";
import { usePersistence } from "@/providers/PersistenceProvider";
import clsx from "clsx";

type Tab = "all" | "official" | "news" | "opinion" | "social";

// P6-T4 sources panel. Group tabs, per-engine status, refresh (backend flag).

export function SourcesPanel({ event }: { event: EventRecord }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("all");
  const [refreshing, setRefreshing] = useState(false);
  const { push } = useToast();
  const { markSyncing, markSynced, markLocal } = usePersistence();

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
            markSyncing();
            try {
              const { appended, engineStatus } = await api.refreshSources(
                event.id,
              );
              const engineSummary = engineStatus
                .map(
                  (e) =>
                    `${e.engine}${e.ok ? "" : "·down"}${
                      e.itemsFound != null ? " " + e.itemsFound : ""
                    }`,
                )
                .join(" · ");
              push({
                kind: "success",
                message: `Appended ${appended} new · ${engineSummary}`,
              });
              markSynced();
              router.refresh();
            } catch (e) {
              if (e instanceof ApiError && e.status === 503) {
                markLocal();
                push({
                  kind: "warning",
                  message:
                    "Local only — set GH_PAT in Vercel env to enable writes",
                });
              } else {
                markSynced();
                push({ kind: "danger", message: (e as Error).message });
              }
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
              {refreshing ? (
                <RefreshCw size={9} className="animate-spin text-tx3" />
              ) : (
                <span className="h-[6px] w-[6px] rounded-full bg-success" />
              )}
              {es.engine}
              {es.itemsFound != null ? (
                <span className="text-tx3">· {es.itemsFound}</span>
              ) : null}
            </span>
          ) : (
            <SourceUnavailableChip
              key={es.engine}
              engine={es.engine}
              reason={
                es.engine === "twitter"
                  ? "TWITTERAPI_IO_KEY unset"
                  : "fetch failed"
              }
              lastGood={es.lastGood}
            />
          ),
        )}
        {refreshing ? (
          <span className="ml-1 flex items-center gap-2 font-mono text-[10.5px] text-tx-mid">
            <RefreshCw size={11} className="animate-spin" />
            refreshing engines…
          </span>
        ) : null}
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
