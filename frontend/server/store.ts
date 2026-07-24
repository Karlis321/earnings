// Store repository interface. All backend endpoints read/write through this.
// v1 = in-memory (fixture-backed). W3 will add gitSnapshot for real writes.

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
import { inMemoryStore } from "./stores/inMemory";

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

  readSharedState(): Promise<SharedState>;
  writeSharedState(state: SharedState): Promise<void>;

  readFeedback(): Promise<FeedbackEntry[]>;
  appendFeedback(entry: FeedbackEntry): Promise<void>;

  readDictionary(): Promise<MetricDictionary>;
  writeDictionary(dict: MetricDictionary): Promise<void>;

  snapshotAt(): Promise<string>;
  ghPatPresent(): boolean;
  mode(): "in-memory" | "git-snapshot" | "postgres";
}

export const store: Store = inMemoryStore;
