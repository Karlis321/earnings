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
// How often the issuer reports. Detected by the estimator via gap
// clustering across past-event dates; snap targets are ~91 / ~182 / ~365
// days. Used to project forward the *right* number of days (a quarterly
// bias would leave BHP/Rio/Unilever as "unscheduled" forever) and to
// hint at what the UI card should say ("H2 results expected ~Feb").
export type Cadence = "quarterly" | "semiannual" | "annual" | "unknown";
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
  // Rolling count of news items + press releases mentioning this
  // entity within the last 14 days. Populated by cron / a local
  // backfill via fetchEntityNews + fetchPressReleases. Independent
  // of event coverage — universe tickers without earnings events
  // still have a live news count for the watchlist SRC column.
  sourceCount?: number;
  sourceCountAsOf?: string;
  // Yahoo `assetProfile.industry` — GICS-industry-group-granularity
  // label (e.g. "Semiconductors", "Software—Infrastructure",
  // "Metals & Mining", "Banks—Diversified", "Oil & Gas E&P").
  // Coarser than sectorTags (which mixes materials/thematic labels);
  // finer than the top-level Yahoo sector. Used by the watchlist to
  // break down each cap band into industry-group sub-groups. Kept
  // alongside sectorTags for backward compat — the old field still
  // drives the tab-filter chips; industryGroup is the *grouping*
  // dimension inside each tab.
  industryGroup?: string | null;
  industryGroupAsOf?: string;
  // "direct" = fetched from Yahoo assetProfile for this entity.
  // "inherited" = copied from the canonical member of the same company
  //   after entity-group detection (Part 2). Preserves the audit trail
  //   so a re-backfill knows which values are ground truth vs propagated.
  industryGroupSource?: "direct" | "inherited";
  // Company grouping (Part 2 of the entity-dedup work). Every entity
  // belongs to exactly one company; the group can have any number of
  // listings. `isCanonical` marks the one listing UI aggregations count
  // (search results, cap-band × industry views, sector aggregates).
  // Populated by scripts/apply-entity-groups.mjs. Singletons get their
  // own companyId so this field is never absent after backfill.
  companyId?: string;
  isCanonical?: boolean;
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
  // True when the horizon window extended past the last available bar
  // and the return was computed against the latest close instead
  // (partial-horizon result — "we ran out of chart before the horizon").
  clipped?: boolean;
  // True when a NEWER same-ticker event fell inside this horizon window,
  // meaning the price move mixes two earnings reactions. Display but
  // visually de-emphasize.
  contaminated?: boolean;
  // Terminal decay state (Part 6 of entity-dedup work). Applied when the
  // event's report date is >60 trading days past AND the security's
  // baseline bars still cannot be fetched — flips this horizon from
  // "pending" (will retry forever) to "unavailable" (give up). Keeps
  // the pipeline-report's `reactions_pending` counter meaningful: it
  // now represents *live* maturation candidates only.
  status?: "matured" | "clipped" | "pending" | "unavailable";
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

// Which pipe produced this event's core structure. Metric-level source
// is on `Fact.source.label`; this is the WHOLE-event provenance so a
// glance at an EventRecord tells you where the shell came from.
export type EventProvenance =
  | "yahoo-earnings-chart" // buildPastEvent / buildEventShell
  | "yahoo-timeseries" // scripts/backfill-yahoo-timeseries.mjs
  | "sec-xbrl-companyfacts" // scripts/backfill-sec-events.mjs
  | "sec-submissions" // scripts/backfill-sec-submissions-shells.mjs
  | "fmp" // scripts/backfill-fmp.mjs
  | "estimator-median-gap" // scripts/run-estimator.mjs
  | "manual-entry" // ManualEntryForm
  | "fixture";

// One-liner "Source" click-through on every event. Computed at event
// creation time from provenance (see computeSourceLink). "filing" means
// we have a direct filing/release URL; "fallback" means we linked the
// best available page (Yahoo financials, EDGAR filings index, ...) and
// the UI should render it as "check the source".
export interface SourceLink {
  url: string;
  kind: "filing" | "fallback";
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
  // Which backfill / cron step produced this event. Set once at
  // creation; not overwritten by later mutations. Optional for
  // backwards-compat with events written before this field existed.
  provenance?: EventProvenance;
  provenanceAsOf?: string; // ISO — when this event was first produced
  // Reporting cadence detected by the estimator (only populated on
  // estimator-projected shells). "quarterly" | "semiannual" | "annual".
  cadence?: Cadence;
  metrics: MetricEntry[];
  guidance: GuidanceEntry[];
  catalysts?: CatalystDetail[];
  // Best-effort click-through to the source document. Computed from
  // provenance at event creation time; null for estimator shells /
  // fixture rows / unknown provenance. See computeSourceLink.
  sourceLink?: SourceLink | null;
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
    // Reporting cadence — when set to semiannual/annual the UI should
    // prefer the fuzzy `label` over the precise ISO date, since the
    // estimator only knows the month.
    cadence?: Cadence;
  };
  lastPeriod: string | null;
  lastSurprisePct: number | null;
  guidanceMove: GuidanceMove;
  reactionSpark: number[]; // 4 values, one per horizon, null-safe
  reactionPending: boolean;
  // Full reaction horizons on the latest past event — populated by the
  // index builder so the compact <ReactionRow /> can render on the
  // sector row + watchlist expanded row without touching the shard.
  reactionPoints?: ReactionPoint[];
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

// Lightweight per-ticker index — replaces monolithic earnings.json reads
// for the watchlist / overview grid. Populated by scripts/shard-earnings.mjs
// and refreshed by the cron.
export interface EventsIndexEntry {
  ticker: string;
  count: number;
  lastEventId: string | null;
  lastEventDate: string | null; // ISO YYYY-MM-DD
  lastPeriod: string | null;
  lastSurprisePct: number | null;
  nextEventId: string | null;
  nextScheduled: string | null; // ISO YYYY-MM-DD
  nextPeriod: string | null;
  nextIsEstimated: boolean; // true when scheduled via median-gap estimator
  // Reporting cadence detected by the estimator when the next-event
  // shell is estimator-produced. Absent for Yahoo-confirmed dates.
  // The UI uses this to render "H2 results expected ~Feb" instead of
  // a spuriously precise day for a semi-annual or annual filer.
  nextCadence?: Cadence;
  sourceCount: number;
  guidanceMove: GuidanceMove;
  freshness: Freshness;
  // Reaction horizons on the latest past event — carried in the index
  // so the sector member rows + watchlist expanded row can render a
  // compact ReactionRow without loading the full shard. Undefined when
  // the last event has no reaction points (developer / etf / not-yet
  // -matured shells).
  lastEventReactionPoints?: ReactionPoint[];
}

export interface EventsIndex {
  schema: "events-index/v1";
  updatedAt: string;
  entries: EventsIndexEntry[];
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
