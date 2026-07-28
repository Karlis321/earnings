// Shape mirrors PRD Appendix C.5 (entity registry) + C.6 (earnings.json).
// Every sourced number is a Fact; derived numbers store inputs + computedAt.

export type SecurityType = "operating" | "developer" | "etf";
export type CapTier = "small" | "mid" | "large" | "mega" | "unknown";
export type Freshness = "fresh" | "overdue" | "stale" | "never";
export type Coverage = "deep" | "headline";
export type EventKind = "earnings" | "catalyst";
export type Timing = "BMO" | "AMC" | "intraday" | null;
export type Expectation = "below" | "inline" | "above" | "unset";
export type GuidanceMove =
  | "raised"
  | "held"
  | "cut"
  | "initiated"
  | "withdrawn"
  | null;
export type Horizon = "d1" | "d3" | "w1" | "m1";
export type FactMethod =
  | "yahoo"
  | "fmp"
  | "bloomberg_manual"
  | "filing_manual"
  | "llm_extracted";
export type Provenance =
  | "regulatory"
  | "ir-page"
  | "wire"
  | "news"
  | "social"
  | "independent";
export type ArticleType = "news" | "opinion";
export type Engine =
  | "google"
  | "bing"
  | "gdelt"
  | "hn"
  | "edgar"
  | "newsfile"
  | "ir-rss"
  | "b3-mziq"
  | "twitter"
  | "nitter";

export interface FactSource {
  url: string;
  label: string;
  provenance: Provenance;
  locator: string | null;
}

export interface Fact {
  value: number | null;
  unit: string;
  source: FactSource | null;
  asOf: string | null; // ISO date
  fetchedAt: string | null; // ISO datetime
  method: FactMethod;
  confidence: number; // 0..1
}

export interface OfficialSource {
  kind: "edgar" | "ir-rss" | "ir-page" | "newsfile" | "b3-mziq" | "html";
  url: string;
  label: string;
  cik?: string;
  provenance: Provenance;
}

export interface Entity {
  ticker: string;
  legalName: string;
  displayName: string;
  aliases: string[];
  exclusionAliases: string[];
  sectorTags: string[];
  cashtag: string | null;
  isCore: boolean;
  securityType: SecurityType;
  coverage: Coverage;
  listing: string;
  currency: string;
  benchmark: string;
  headlineMetrics: string[];
  catalystTypes: string[];
  xHandle?: string | null;
  officialSources?: OfficialSource[];
  marketCapUsd?: number | null;
  marketCapAsOf?: string | null;
  capTier?: CapTier;
  // Yahoo symbol persisted at registry-write time so cron + backfill
  // skip the ambiguous yahooLookup search. Prevents cases like VLE CN
  // resolving to a look-alike penny stock or RIO FP hitting Rio Tinto
  // instead of the Amundi Brazil ETF that shares the ticker.
  yahooSymbol?: string;
  // SEC EDGAR CIK (10-digit zero-padded) if the issuer files with the SEC.
  // Resolved automatically at add-entity time via SEC's public
  // ticker→CIK JSON and refreshed by cron. `null` = confirmed not an SEC
  // filer (searched and not found); `undefined` = not yet checked.
  edgarCik?: string | null;
  // TTM fundamentals from Yahoo `financialData` + `defaultKeyStatistics`.
  // Refreshed alongside marketCap in the daily cron; populated at
  // add-entity time when Yahoo returns data. Not every field is
  // available for every issuer (foreign wrappers often return null).
  fundamentals?: EntityFundamentals | null;
}

export interface EntityFundamentals {
  totalRevenueTTM: number | null;
  ebitdaTTM: number | null;
  grossMargin: number | null; // 0..1
  operatingMargin: number | null;
  ebitdaMargin: number | null;
  revenueGrowth: number | null; // 0..1 YoY
  sharesOutstanding: number | null;
  enterpriseValue: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
  profitMargin: number | null;
  currency: string | null;
  asOf: string; // ISO date
}

export interface MetricEntry {
  key: string;
  displayLabel: string;
  isHeadline: boolean;
  surprisePct: number | null; // null means "n/a — no estimate"
  estimate: Fact | null;
  actual: Fact | null;
  prior?: Fact | null;
}

export interface GuidanceEntry {
  key: string;
  displayLabel: string;
  period: string;
  basis: string;
  version: number;
  supersededById: string | null;
  move: GuidanceMove;
  low: Fact | null;
  high: Fact | null;
  midpoint: Fact | null;
}

export interface ReactionPoint {
  horizon: Horizon;
  absReturn: number | null;
  excessReturn: number | null;
  benchmark: string;
  computedAt: string | null;
  gapFlagged?: boolean;
  populatesOn?: string; // ISO date — when a pending horizon will populate
}

export interface Reaction {
  benchmark: string;
  baselineDate: string | null;
  baselineClose: number | null;
  points: ReactionPoint[];
}

export interface SourceItem {
  id: string;
  url: string;
  headline: string;
  source: string;
  provenance: Provenance;
  time: string;
  articleType: ArticleType;
  engine: Engine;
  language: string; // "en" | "pt" | ...
  hosted: boolean;
  summary: string | null; // null in $0 mode
  engagement?: { likes: number; reposts: number; replies: number };
}

export interface CatalystDetail {
  type: string; // e.g. "PEA", "Feasibility Study", "Drill Result"
  title: string;
  expectedDate: string | null;
  actualDate: string | null;
  expectation: Expectation;
  keyValues: Array<{ label: string; value: string }>;
  source: FactSource | null;
}

export interface EventRecord {
  id: string;
  ticker: string;
  kind: EventKind;
  period: string;
  scheduledDate: string;
  eventDate: string | null;
  timing: Timing;
  catalystType?: string;
  expectation: Expectation;
  guidanceMove: GuidanceMove;
  freshness: Freshness;
  metrics: MetricEntry[];
  guidance: GuidanceEntry[];
  catalysts?: CatalystDetail[];
  reaction: Reaction;
  sources: {
    windowStart: string;
    windowEnd: string;
    capturedAt: string | null;
    items: SourceItem[];
    engineStatus: EngineStatus[];
  };
  verdictNote?: { text: string; lastEditedAt: string } | string;
}

export interface EtfDistribution {
  exDate: string;
  amount: number;
  currency: string;
  yieldPct: number;
}

export interface EtfHolding {
  ticker: string;
  name: string;
  weight: number;
  asOf: string;
}

export interface EtfDetail {
  price: Fact;
  distributions: EtfDistribution[];
  holdings: EtfHolding[];
  usedAsBenchmarkFor: string[]; // list of tickers
}

export interface WatchlistRow {
  ticker: string;
  entity: Entity;
  nextEvent: {
    date: string | null;
    daysUntil: number | null;
    label: string;
  };
  lastPeriod: string | null;
  lastSurprisePct: number | null;
  guidanceMove: GuidanceMove;
  reactionSpark: number[]; // 4 values, one per horizon, null-safe
  reactionPending: boolean;
  freshness: Freshness;
  sourceCount: number;
  newSinceLastView: number;
  dataIncomplete: boolean;
  recentEvent: boolean;
}

export interface EarningsSnapshot {
  schema: "earnings/v1";
  lastUpdated: string;
  events: EventRecord[];
  etfDetails?: Record<string, EtfDetail>;
}

export interface SharedState {
  schema: "shared-state/v1";
  watchlist: string[];
  customSources: Array<{
    id: string;
    kind: "rss" | "site-filter" | "twitter" | "substack";
    url: string;
    title: string;
    scope: { tickers: string[]; themes: string[] };
    addedAt: string;
    active: boolean;
    lastFetch: {
      at: string;
      ok: boolean;
      itemsFound: number;
      error: string | null;
    } | null;
  }>;
  themes: Array<{ id: string; label: string; active: boolean }>;
  lastCommit: string;
}

export interface MetricDictionary {
  schema: "metric-dictionary/v1";
  metrics: Record<
    string,
    {
      label: string;
      unit: string;
      requiresIsAdjusted: boolean;
      description: string | null;
    }
  >;
}

export interface EngineStatus {
  engine: Engine;
  ok: boolean;
  lastGood?: string;
  itemsFound?: number;
}

export interface CronRunSummary {
  schema: "cron-status/v1";
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  durationMs: number;
  engines: EngineStatus[];
  events: Array<{
    eventId: string;
    ticker: string;
    appended: number;
    maturedHorizons: Horizon[];
    errors: string[];
  }>;
  totalAppended: number;
  totalMatured: number;
  newEvents: Array<{
    eventId: string;
    ticker: string;
    period: string;
    scheduledDate: string;
  }>;
  restatements: Array<{
    eventId: string;
    ticker: string;
    metricKey: string;
    priorValue: number;
    restatedValue: number;
    deltaPct: number; // positive percentage
    at: string;
  }>;
  documents: {
    attempted: number;
    ingested: number; // changed=true, wrote a new version
    unchanged: number; // reachable but hash unchanged
    failed: number;
    // Latest ingest headlines (bounded so the file stays small)
    recent: Array<{
      id: string;
      url: string;
      ingestVersion: number;
      changed: boolean;
      kind: DocumentKind | null;
      error?: string;
    }>;
  };
  marketCap?: {
    attempted: number;
    updated: number;
    unchanged: number;
    failed: number;
    tierChanges: Array<{
      ticker: string;
      priorTier: CapTier;
      newTier: CapTier;
      marketCapUsd: number | null;
    }>;
  };
}

export interface DiscoverFeedResult {
  kind: "rss" | "site-filter" | "twitter" | "substack" | "rejected";
  url: string;
  title?: string;
  note?: string;
}

export interface FeedbackEntry {
  id: string;
  target: "item" | "source" | "keyword";
  targetId: string;
  action: "thumbs_up" | "thumbs_down" | "block" | "not_relevant";
  createdBy: string;
  createdAt: string;
}

export type DocumentKind =
  | "article"
  | "transcript"
  | "filing"
  | "press-release";

export interface TranscriptSegment {
  id: string; // "seg-1", "seg-2", ...
  speaker: string | null;
  role: "prepared" | "qa" | "unknown";
  paragraphIds: string[]; // ["para-4", "para-5", ...]
}

export interface DocumentMeta {
  id: string;
  url: string;
  title: string;
  publishedAt: string | null;
  source: string;
  provenance: Provenance;
  language: string;
  fetchedAt: string;
  ingestVersion: number;
  sourceContentHash: string;
  kind: DocumentKind;
  paragraphCount: number;
  segments: TranscriptSegment[];
}

export interface Document {
  schema: "document/v1";
  meta: DocumentMeta;
  html: string;
}
