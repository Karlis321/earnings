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

  // Market Pulse snapshot committed daily by
  // scripts/refresh-market-pulse.mjs (4 indices × 3 ranges of Yahoo
  // daily bars + live regularMarketPrice append). Overview page reads
  // this so the chart paints instantly from committed data instead of
  // hitting Yahoo per visitor.
  readMarketPulse?(): Promise<unknown | null>;

  // Feature 3A signal ranking (data/ranking.json). Written by
  // scripts/run-ranking.mjs. Consumed by /ideas (Feature 3B).
  // Returns null when the ranking hasn't been computed yet.
  readRanking?(): Promise<import("@/lib/types").Ranking | null>;

  // Feature 3C AI pitch cards (data/ideas.json). Written by
  // .claude/commands/ideas.md via scripts/apply-ideas.mjs. Overwritten
  // 3×/week (Mon/Wed/Fri) by .github/workflows/ideas.yml. Consumed
  // by /ideas as a top-strip above the ranking table.
  readIdeas?(): Promise<import("@/lib/types").Ideas | null>;

  // Feature 2C macro extremity signals (data/macro-signals.json).
  // Written by scripts/refresh-macro.mjs (phase in refresh-universe).
  // Consumed by /week-ahead as an extremity strip above the day grid.
  readMacroSignals?(): Promise<import("@/lib/types").MacroSignals | null>;

  // Feature 2F weekly narrative (data/week-ahead-narrative.json).
  // Written by .claude/commands/week-ahead.md via
  // scripts/apply-week-ahead.mjs on Sunday 22:00 UTC. Rendered as
  // a panel above the macro strip on /week-ahead.
  readWeekAheadNarrative?(): Promise<
    import("@/lib/types").WeekAheadNarrative | null
  >;

  // Feature 3.3 per-week archive. `listWeekAheadArchive` returns
  // available weekOf ISO dates newest-first (empty when the archive
  // directory doesn't exist yet). `readWeekAheadArchive` reads one
  // week's narrative (returns null if the archive is missing or the
  // input weekOf isn't a YYYY-MM-DD).
  listWeekAheadArchive?(): Promise<string[]>;
  readWeekAheadArchive?(
    weekOf: string,
  ): Promise<import("@/lib/types").WeekAheadNarrative | null>;

  // Feature 4A framework screens (data/screens/<framework>.json).
  // Written by .claude/commands/{blue-ocean,rule-breaker}.md via
  // scripts/apply-screen.mjs. Monthly self-chaining workflow
  // (framework-screen.yml). Consumed by /screens (Feature 4C).
  readScreen?(
    framework: import("@/lib/types").ScreenFramework,
  ): Promise<import("@/lib/types").Screen | null>;

  // Phase 3.4 — framework screen change log (jsonl). Filtered to
  // `ticker` when provided. Returns [] on missing file / read error.
  readScreenChangeLog?(
    framework: import("@/lib/types").ScreenFramework,
    ticker?: string,
  ): Promise<import("@/lib/types").ScreenChangeLogRow[]>;

  // Phase 4.1 — pairwise correlation snapshot (data/correlations.json).
  // Refreshed by scripts/refresh-correlations.mjs. Consumed by
  // /correlation. Null when the snapshot file doesn't exist yet.
  readCorrelations?(): Promise<import("@/lib/types").Correlations | null>;

  // Feature 3.1 ranking history (data/ranking-history.jsonl).
  // Appended daily by scripts/append-ranking-history.mjs. Filtered
  // to `ticker` when provided (cheap: one grep pass over the
  // file). Consumed by /s/[ticker] composite sparkline.
  readRankingHistory?(
    ticker?: string,
  ): Promise<import("@/lib/types").RankingHistoryRow[]>;

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
