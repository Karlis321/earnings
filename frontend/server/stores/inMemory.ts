import type {
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
