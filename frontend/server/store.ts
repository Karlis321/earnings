// Store repository interface. All backend endpoints read/write through this.
// v1 = in-memory (fixture-backed). W3 will add gitSnapshot for real writes.

import type {
  CronRunSummary,
  Document,
  EarningsSnapshot,
  Entity,
  EventRecord,
  EventsIndex,
  FeedbackEntry,
  ReactionPoint,
  SourceItem,
  SharedState,
  MetricDictionary,
  EngineStatus,
  Summary,
} from "@/lib/types";
import type {
  PipelineHistoryEntry,
  PipelineReport,
} from "./lib/pipelineReport";
import { inMemoryStore } from "./stores/inMemory";
import { tryGitSnapshot } from "./stores/gitSnapshot";

export interface Store {
  readRegistry(): Promise<Entity[]>;
  writeRegistry(entities: Entity[]): Promise<void>;

  readEarnings(): Promise<EarningsSnapshot>;
  // Lightweight index of every ticker's event summary — the shape the
  // watchlist / overview grid needs. Reads a small file
  // (data/events-index.json) instead of the 10+ MB monolith. Falls
  // back to computing from readEarnings() when the index isn't present.
  readEventsIndex?(): Promise<EventsIndex>;
  // Per-ticker event shard read — for security detail pages. Falls
  // back to filtering readEarnings().events when shards aren't present.
  readEventsForTicker?(ticker: string): Promise<EventRecord[]>;
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

  // Daily pipeline self-check. `writePipelineReport` overwrites the
  // latest snapshot; `readPipelineHistory` returns the append-only jsonl
  // (last N days) for the health-page sparkline; `appendPipelineHistory`
  // adds one row per cron run.
  readPipelineReport?(): Promise<PipelineReport | null>;
  writePipelineReport?(report: PipelineReport): Promise<void>;
  readPipelineHistory?(): Promise<PipelineHistoryEntry[]>;
  appendPipelineHistory?(entry: PipelineHistoryEntry): Promise<void>;

  readDocument(id: string): Promise<Document | null>;
  writeDocument(doc: Document): Promise<void>;

  // Post-earnings summaries written by the /earnings command. Resolves
  // the input ticker to its canonical listing (so any member ticker
  // finds the company's summaries) and returns every summary file
  // for that canonical, sorted latest-period first. Optional so the
  // in-memory store can stub-implement while gitSnapshot has the real
  // directory read.
  readSummariesForTicker?(ticker: string): Promise<Summary[]>;

  snapshotAt(): Promise<string>;
  ghPatPresent(): boolean;
  mode(): "in-memory" | "git-snapshot" | "postgres";
}

// Auto-select store implementation:
// - If GH_PAT + GH_REPO_OWNER + GH_REPO_NAME are set → gitSnapshot (writes commit to GitHub).
// - Else → in-memory (reads work; writes throw 503-shape errors).
export const store: Store = tryGitSnapshot() ?? inMemoryStore;
