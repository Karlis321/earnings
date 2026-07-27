// Store repository interface. All backend endpoints read/write through this.
// v1 = in-memory (fixture-backed). W3 will add gitSnapshot for real writes.

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
import { inMemoryStore } from "./stores/inMemory";
import { tryGitSnapshot } from "./stores/gitSnapshot";

export interface Store {
  readRegistry(): Promise<Entity[]>;
  writeRegistry(entities: Entity[]): Promise<void>;

  readEarnings(): Promise<EarningsSnapshot>;
  upsertEvent(event: EventRecord): Promise<void>;
  appendEventSources(
    eventId: string,
    items: SourceItem[],
    engineStatus: EngineStatus[],
  ): Promise<void>;
  setReactionPoint(eventId: string, point: ReactionPoint): Promise<void>;
  setVerdictNote(eventId: string, text: string): Promise<void>;
  // Single-commit path used by the cron: all in-memory mutations
  // collapse into one git commit per run.
  mutateEarnings(
    mutator: (snap: EarningsSnapshot) => EarningsSnapshot,
    message: string,
  ): Promise<void>;

  readSharedState(): Promise<SharedState>;
  writeSharedState(state: SharedState): Promise<void>;

  readFeedback(): Promise<FeedbackEntry[]>;
  appendFeedback(entry: FeedbackEntry): Promise<void>;

  readDictionary(): Promise<MetricDictionary>;
  writeDictionary(dict: MetricDictionary): Promise<void>;

  readCronStatus(): Promise<CronRunSummary | null>;
  writeCronStatus(status: CronRunSummary): Promise<void>;

  readDocument(id: string): Promise<Document | null>;
  writeDocument(doc: Document): Promise<void>;

  snapshotAt(): Promise<string>;
  ghPatPresent(): boolean;
  mode(): "in-memory" | "git-snapshot" | "postgres";
}

// Auto-select store implementation:
// - If GH_PAT + GH_REPO_OWNER + GH_REPO_NAME are set → gitSnapshot (writes commit to GitHub).
// - Else → in-memory (reads work; writes throw 503-shape errors).
export const store: Store = tryGitSnapshot() ?? inMemoryStore;
