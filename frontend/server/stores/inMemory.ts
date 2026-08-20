import type {
  CronRunSummary,
  Document,
  EarningsSnapshot,
  Entity,
  EventRecord,
  FeedbackEntry,
  ReactionPoint,
  SourceItem,
  SharedState,
  MetricDictionary,
  EngineStatus,
} from "@/lib/types";
import type { Store } from "../store";
import { ENTITY_REGISTRY, METRIC_LABELS } from "@/lib/fixtures/registry";
import { EARNINGS_FIXTURE } from "@/lib/fixtures/earnings";
import { ETF_DETAILS } from "@/lib/fixtures/etf";
import { FEEDBACK_LOG, SHARED_STATE } from "@/lib/fixtures/sharedState";

function notImplemented(op: string): never {
  throw new Error(`store.${op} not implemented in in-memory · W3 pending`);
}

const dictionary: MetricDictionary = {
  schema: "metric-dictionary/v1",
  metrics: Object.fromEntries(
    Object.entries(METRIC_LABELS).map(([key, meta]) => [
      key,
      {
        label: meta.label,
        unit: meta.unit,
        requiresIsAdjusted: key.startsWith("eps"),
        description: null,
      },
    ]),
  ),
};

const sharedState: SharedState = {
  schema: "shared-state/v1",
  watchlist: SHARED_STATE.watchlist,
  customSources: SHARED_STATE.customSources.map((s) => ({
    ...s,
    lastFetch: null,
  })),
  themes: SHARED_STATE.themes,
  lastCommit: SHARED_STATE.lastCommit,
};

// Attach ETF details to the earnings snapshot for the discriminated-union endpoint.
const snapshotWithEtf: EarningsSnapshot = {
  ...EARNINGS_FIXTURE,
  etfDetails: ETF_DETAILS,
};

export const inMemoryStore: Store = {
  async readRegistry(): Promise<Entity[]> {
    return ENTITY_REGISTRY;
  },
  async writeRegistry(): Promise<void> {
    notImplemented("writeRegistry");
  },

  async readEarnings(): Promise<EarningsSnapshot> {
    return snapshotWithEtf;
  },
  async readEventsIndex() {
    const byTicker = new Map<string, EventRecord[]>();
    for (const ev of snapshotWithEtf.events) {
      if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
      byTicker.get(ev.ticker)!.push(ev);
    }
    const entries = [] as import("@/lib/types").EventsIndexEntry[];
    for (const [ticker, events] of byTicker) {
      const past = events.filter((e) => e.eventDate);
      past.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
      const future = events.filter((e) => !e.eventDate);
      future.sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
      const latest = past[0];
      const next = future[0];
      entries.push({
        ticker,
        count: events.length,
        lastEventId: latest?.id ?? null,
        lastEventDate: latest?.eventDate ?? null,
        lastPeriod: latest?.period ?? null,
        lastSurprisePct:
          latest?.metrics?.find((m) => /eps/i.test(m.key ?? ""))?.surprisePct ?? null,
        nextEventId: next?.id ?? null,
        nextScheduled: next?.scheduledDate ?? null,
        nextPeriod: next?.period ?? null,
        nextIsEstimated: !!next && next.freshness === "stale",
        sourceCount: 0,
        guidanceMove: latest?.guidanceMove ?? null,
        freshness: latest?.freshness ?? "never",
      });
    }
    return {
      schema: "events-index/v1" as const,
      updatedAt: snapshotWithEtf.lastUpdated,
      entries,
    };
  },
  async readEventsForTicker(ticker: string) {
    return snapshotWithEtf.events.filter((e) => e.ticker === ticker);
  },
  async upsertEvent(_event: EventRecord): Promise<void> {
    notImplemented("upsertEvent");
  },
  async appendEventSources(
    _eventId: string,
    _items: SourceItem[],
    _engineStatus: EngineStatus[],
  ): Promise<void> {
    notImplemented("appendEventSources");
  },
  async setReactionPoint(
    _eventId: string,
    _point: ReactionPoint,
  ): Promise<void> {
    notImplemented("setReactionPoint");
  },
  async setVerdictNote(_eventId: string, _text: string): Promise<void> {
    notImplemented("setVerdictNote");
  },
  async mutateEarnings(): Promise<void> {
    notImplemented("mutateEarnings");
  },

  async readSharedState(): Promise<SharedState> {
    return sharedState;
  },
  async writeSharedState(): Promise<void> {
    notImplemented("writeSharedState");
  },

  async readFeedback(): Promise<FeedbackEntry[]> {
    return FEEDBACK_LOG as unknown as FeedbackEntry[];
  },
  async appendFeedback(_entry: FeedbackEntry): Promise<void> {
    notImplemented("appendFeedback");
  },

  async readDictionary(): Promise<MetricDictionary> {
    return dictionary;
  },
  async writeDictionary(): Promise<void> {
    notImplemented("writeDictionary");
  },

  async readCronStatus(): Promise<CronRunSummary | null> {
    return null;
  },
  async writeCronStatus(): Promise<void> {
    notImplemented("writeCronStatus");
  },

  async readPipelineReport() {
    return null;
  },
  async readMarketPulse() {
    return null;
  },
  async readRanking() {
    return null;
  },
  async readIdeas() {
    return null;
  },
  async readMacroSignals() {
    return null;
  },
  async readWeekAheadNarrative() {
    return null;
  },
  async readScreen() {
    return null;
  },
  async readRankingHistory() {
    return [];
  },
  async writePipelineReport(): Promise<void> {
    notImplemented("writePipelineReport");
  },
  async readPipelineHistory() {
    return [];
  },
  async appendPipelineHistory(): Promise<void> {
    notImplemented("appendPipelineHistory");
  },

  async readDocument(_id: string): Promise<Document | null> {
    return null;
  },
  async writeDocument(): Promise<void> {
    notImplemented("writeDocument");
  },

  // The in-memory store is fixture-only — no summaries corpus is
  // baked in. Return empty so RSC callers render nothing (correct
  // per spec: no summary → no panel).
  async readSummariesForTicker(_ticker: string) {
    return [];
  },

  async snapshotAt(): Promise<string> {
    return snapshotWithEtf.lastUpdated;
  },
  ghPatPresent(): boolean {
    return Boolean(process.env.GH_PAT);
  },
  mode(): "in-memory" | "git-snapshot" | "postgres" {
    return "in-memory";
  },
};
