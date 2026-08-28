// Shape mirrors PRD Appendix C.5 (entity registry) + C.6 (earnings.json).
// Every sourced number is a Fact; derived numbers store inputs + computedAt.

// Feature 4A — framework-screen output. One file per framework
// at data/screens/<framework>.json. Written by
// .claude/commands/<framework>.md via scripts/apply-screen.mjs.
// Consumed by /screens (Feature 4C).
export type ScreenFramework = "blue-ocean" | "rule-breaker" | "qarv";
export interface ScreenDimensionDef {
  key: string;
  label: string;
  description?: string;
}
export interface ScreenDimensionScore {
  key: string;
  // 0-100 percentile, or null when the underlying factor is
  // unresolvable (missing data on that ticker). Null renders as "—"
  // in the UI to distinguish "no data" from "bottom of universe".
  // LLM-narrative frameworks (blue-ocean, rule-breaker) never emit
  // null since the sub-agent scores every dimension; mechanical
  // frameworks (qarv) may emit null when a factor lacks input.
  score: number | null;
  rationale: string;
}
export interface ScreenSourceRef {
  kind: "summary" | "shard" | "filing" | "release" | "web";
  ref: string;
}
export interface ScreenCard {
  ticker: string;
  companyId: string | null;
  displayName: string;
  compositeScore: number;
  dimensions: ScreenDimensionScore[];
  verdict: string;
  sources: ScreenSourceRef[];
  screenedAt: string;
  // Phase 3.4 — carried on the ScreenCard so the UI can display a
  // "+n since last run" delta chip without reading the change-log
  // jsonl. Written by scripts/apply-screen.mjs when a re-screen
  // overwrites an existing row; null on first-time ingest.
  previousCompositeScore?: number | null;
  previousScreenedAt?: string | null;
}

// Phase 4.1 — pairwise Pearson correlation snapshot over the
// watchlist universe. Computed by scripts/refresh-correlations.mjs.
// matrix[a][b] is the correlation of daily log returns between
// tickers `a` and `b` over `range`. Null when the two series share
// fewer than `minSharedBars` overlapping trading days.
export interface Correlations {
  schema: "correlations/v1";
  generatedAt: string;
  range: string;
  minSharedBars: number;
  tickers: string[];
  matrix: Record<string, Record<string, number | null>>;
}

// Phase 4.2 — commodity price snapshot for the /week-ahead
// commodity strip. Yahoo commodity futures (WTI/Brent/nat gas/
// gold/silver/copper/platinum/corn). Written by
// scripts/refresh-commodities.mjs.
export interface CommodityBar {
  date: string;
  close: number;
}
export interface CommodityItem {
  symbol: string;
  label: string;
  unit: string;
  group: "energy" | "precious" | "base" | "ag";
  currency: string | null;
  latest: { date: string; close: number } | null;
  change1d: number | null;
  change5d: number | null;
  change30d: number | null;
  change90d: number | null;
  bars: CommodityBar[];
  error?: string;
}
export interface Commodities {
  schema: "commodities/v1";
  generatedAt: string;
  range: string;
  items: CommodityItem[];
}
export interface Screen {
  schema: "screen/v1";
  framework: ScreenFramework;
  generatedAt: string;
  dimensions: ScreenDimensionDef[];
  screens: ScreenCard[];
}

// Feature 2F — weekly AI narrative for /week-ahead. Written by
// .claude/commands/week-ahead.md via scripts/apply-week-ahead.mjs
// on Sunday 22:00 UTC. Rendered as a panel above the macro strip.
export interface WeekAheadSection {
  heading: string;
  body: string;
}
export interface WeekAheadHighlight {
  ticker: string;
  note: string;
  eventDate: string;
}
export interface WeekAheadNarrative {
  schema: "week-ahead-narrative/v1";
  generatedAt: string;
  weekOf: string;
  eventsCount: number;
  sections: WeekAheadSection[];
  highlights: WeekAheadHighlight[];
  disclaimer: string;
}

// Feature 2C — macro extremity signals. Written by
// scripts/refresh-macro.mjs to data/macro-signals.json. Rendered
// on /week-ahead above the day grid as a small chip strip that
// highlights any market-priced series >2σ from its 3-year mean.
export type MacroFlag = "normal" | "elevated" | "extreme";
export interface MacroSignal {
  key: string;
  symbol: string;
  label: string;
  unit: string;
  interpretation: string;
  latest: number;
  latestDate: string;
  window: { years: number; observations: number; mean: number; stdev: number };
  zScore: number;
  flag: MacroFlag;
}
export interface MacroSignals {
  schema: "macro-signals/v1";
  generatedAt: string;
  windowYears: number;
  thresholds: { elevated: number; extreme: number };
  signals: MacroSignal[];
  errors?: string[];
}

// Sector-level rollup for /themes. Aggregated by
// scripts/aggregate-by-sector.mjs from events-index + shards. One
// entry per sectorTag with ≥3 tickers; sectors sorted by
// |medianReaction3d| descending so the strongest theme is first.
export interface SectorTopMover {
  ticker: string;
  displayName: string;
  reaction3d: number | null;
  lastSurprisePct: number | null;
  lastEventDate: string | null;
  lastPeriod: string | null;
  // Count of "hot" sectors (median |reaction3d| >= threshold) the
  // ticker participates in. Rendered as a ×N conviction badge on
  // /themes when >= 2 (multi-hot participation = real convergence).
  // Optional so older snapshots without the field still parse.
  hotSectorCount?: number;
}
export interface SectorHeadline {
  ticker: string;
  headline: string;
  time: string;
  source: string;
  url: string | null;
}
export interface Sector {
  sector: string;
  tickerCount: number;
  medianReaction3d: number | null;
  medianSurprise: number | null;
  newsCountAll: number;
  topMovers: SectorTopMover[];
  recentHeadlines: SectorHeadline[];
  tickers: string[];
}
export interface SectorSignals {
  schema: "sector-signals/v1";
  generatedAt: string;
  newsWindowDays: number;
  minTickersPerSector: number;
  // Threshold used to classify a sector as "hot" for cross-sector
  // conviction. A sector is hot when |medianReaction3d| >= this.
  // Optional so older snapshots without the field still parse.
  hotReactionThreshold?: number;
  hotSectors?: string[];
  sectors: Sector[];
}

// One row per sector per day in data/sector-history.jsonl. Written
// daily by scripts/append-sector-history.mjs after
// aggregate-by-sector completes. Consumed by /themes to compute a
// week-over-week delta chip per sector card.
export interface SectorHistoryRow {
  date: string; // YYYY-MM-DD
  sector: string;
  medianReaction3d: number | null;
  tickerCount: number;
  newsCountAll: number;
}

// LLM-drafted narrative themes on top of sector-signals. Written by
// .claude/commands/sector-ideas.md via scripts/apply-sector-ideas.mjs.
// Rendered on /themes as a panel above the mechanical grid.
// Every claim must be defensible from data/sector-signals.json —
// apply-script cross-checks each theme's sector, each supporting
// ticker's sector membership, and each headline against the real
// recentHeadlines[] for that sector.
export interface SectorThemeHeadline {
  ticker: string;
  headline: string;
  source: string;
}
export interface SectorTheme {
  sector: string;
  thesis: string; // 60-200 chars — the one-line pitch
  rationale: string; // 200-600 chars — supporting body
  supportingTickers: string[]; // 3-6 tickers, must be members of `sector`
  keyHeadlines: SectorThemeHeadline[]; // 3-5 headlines, must exist in sector's recentHeadlines
  dataPoints: {
    medianReaction3d: number | null;
    newsCountAll: number;
    tickerCount: number;
  };
}
export interface SectorIdeas {
  schema: "sector-ideas/v1";
  generatedAt: string;
  themes: SectorTheme[]; // 5-8 themes per run
  disclaimer: string;
}

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
// Provenance vs EventProvenance — two distinct enums, one per level:
//
// `Provenance` here (fact-level) classifies WHERE A SINGLE
// `FactSource` came from — the primary-source category
// (regulatory filing vs company IR page vs newswire vs press vs
// social vs independent research). Used inside every `Fact.source`.
//
// `EventProvenance` further below (event-level) classifies HOW A
// WHOLE EventRecord was created — the specific ingest lane that
// birthed the record (yahoo-earnings-chart vs yahoo-timeseries vs
// sec-xbrl-companyfacts vs sec-submissions vs fmp vs
// llm_extracted). Used for merge-precedence in mergeMetricsInto
// and for the pipeline-report's per-provenance counters.
//
// Not interchangeable. A FactSource whose provenance is
// "regulatory" can live on an event whose EventProvenance is
// "sec-xbrl-companyfacts" — those are consistent — but the two
// fields describe different things and neither can be inferred
// from the other in general.
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
  // Populated by scripts/backfills/apply-entity-groups.mjs. Singletons get their
  // own companyId so this field is never absent after backfill.
  companyId?: string;
  isCanonical?: boolean;
  // IR-source registry (Task 3): WHERE this entity's quarterly
  // results are actually published — the specific page a document
  // appears on, not just the IR homepage. Populated by three passes,
  // strongest-evidence-wins:
  //   1. OBSERVED — mined from past events' sourceLink where kind
  //      was "filing". Ground truth: past behavior predicts next
  //      quarter's location.
  //   2. DERIVED — mechanical URL construction (EDGAR CIK list,
  //      SEDAR issuer-search) or probed IR-page candidates
  //      (<website>/investors/press-releases etc.). Only 200s stored.
  //   3. RESEARCHED — bounded Claude judgment for covered tier +
  //      top uncovered when 1+2 still leave reports_page_url null.
  // Nulls allowed; a URL is NEVER guessed into a field. Every
  // successful /earnings fetch refreshes this record.
  irSources?: IrSources | null;
  // Index membership flags. Independent of sectorTags — an entity's
  // sector doesn't change when it enters/exits the S&P 500, only its
  // membership set does. Array so future index memberships (NASDAQ-100,
  // Russell-1000, TSX-60, etc.) can be added without a schema break.
  // Membership is as_of-dated via the index reference file it came
  // from (e.g. data/reference/sp500.json). A quarterly re-fetch
  // reconciles adds/drops: dropped members lose the flag but keep
  // their historical data + shards.
  index_membership?: string[];
}

export interface IrSources {
  publication_venue: "EDGAR" | "SEDAR" | "company-IR" | "regulator-other" | null;
  reports_page_url: string | null;
  ir_url: string | null;
  press_release_url: string | null;
  rss_feeds: string[];
  publication_pattern: string | null;
  verified_at: string | null;
  source: "observed" | "derived" | "researched";
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

// Extended (LLM-extracted) metric value — a metric Claude pulled
// directly out of the 10-Q / 8-K / EX-99 filing. Sector-driven by
// extendedMetricsRegistry.ts. Always cites the exact filing quote
// so a reader can verify. Confidence 0.9+ = numeric-table hit;
// 0.7-0.9 = prose extraction; <0.7 dropped before write.
export interface ExtendedMetricValue {
  key: string;            // matches ExtendedMetricDef.key
  label: string;
  unit: string;
  // "point" or "range". For range: value=mid, low/high populated.
  shape: "point" | "range";
  value: number | null;
  low?: number | null;
  high?: number | null;
  provenance: "llm_extracted";
  source: {
    url: string;
    section: string;    // "Item 2 · MD&A"; "Cash flow statement"; etc.
    quote: string;      // the exact filing sentence the value was pulled from
  };
  extractedAt: string;
  confidence: number;   // 0-1
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
  | "yahoo-timeseries" // scripts/backfills/backfill-yahoo-timeseries.mjs
  | "sec-xbrl-companyfacts" // scripts/backfills/backfill-sec-events.mjs
  | "sec-submissions" // scripts/backfills/backfill-sec-submissions-shells.mjs
  | "fmp" // scripts/backfills/backfill-fmp.mjs
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
  // Extended metrics extracted by Claude from the filing text — the
  // non-GAAP + segment + operational KPIs that structured feeds
  // (Yahoo timeseries, SEC XBRL) don't carry. Sector-scoped by
  // extendedMetricsRegistry.ts; produced by /earnings step 3b.
  // Every entry cites an exact quote from the filing.
  extendedMetrics?: ExtendedMetricValue[];
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

// The subset of Entity actually consumed by the watchlist + sector
// grouping / filtering code. Full Entity records are ~860 bytes serialized
// (aliases, fundamentals, irSources, headlineMetrics, edgarCik, etc.); the
// watchlist reads only 11 fields per row, so shipping the full record
// pushes ~500 KB of dead payload to the client at 1039 rows. Narrowing
// here catches any accidental new consumer at compile time.
export type WatchlistEntity = Pick<
  Entity,
  | "ticker"
  | "displayName"
  | "securityType"
  | "sectorTags"
  | "capTier"
  | "marketCapUsd"
  | "companyId"
  | "index_membership"
  | "industryGroup"
  | "isCanonical"
  | "isCore"
  // Aliases are used by the sector-view free-text search
  // (SectorGroupsFilter) to match "Alphabet" → GOOGL etc. Cheap
  // to include (~27 KB across the 1,039-row universe).
  | "aliases"
>;

// Slim reaction shape shipped inside a WatchlistRow. ReactionRow only
// renders horizon + absReturn + optional clipped/contaminated flags;
// benchmark, computedAt, gapFlagged, populatesOn, excessReturn are
// not used at the row level (event-detail views read a fresh
// reaction from the shard). Splitting the type here keeps the wire
// payload small without touching downstream ReactionPoint consumers.
export interface WatchlistReactionPoint {
  horizon: Horizon;
  absReturn: number | null;
  // Present when the row builder emitted it (post-2026-08-25). Used
  // by the watchlist popover's 'reaction-d3-excess' sort option.
  // Kept optional so older index snapshots parse cleanly and
  // event-detail views can still fetch a fresh reaction from the
  // shard when they need one.
  excessReturn?: number | null;
  clipped?: boolean;
  contaminated?: boolean;
  // Rendering gate on WatchlistTable's "Last surprise" column — only
  // shows the reaction when status is matured or clipped (not pending
  // / unavailable). Optional so builders that don't have it (fixture
  // path) can omit.
  status?: "matured" | "clipped" | "pending" | "unavailable";
}

export interface WatchlistRow {
  ticker: string;
  entity: WatchlistEntity;
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
  // Revenue surprise on the latest reported event, if present with a
  // same-basis actual + estimate. Sort dimension on the watchlist.
  lastRevenueSurprisePct?: number | null;
  // Y/Y revenue growth on the latest reported quarter. Computed at
  // shard-earnings time by matching latest.period to same-quarter
  // one fiscal year back (FY2026 Q2 → FY2025 Q2). Used as the
  // Beat/miss column fallback when a same-basis surprise isn't
  // available. Optional so older index snapshots parse cleanly.
  yoyRevenueGrowthPct?: number | null;
  // Per-metric snapshot from the latest reported event. Keyed by
  // metric.key (e.g. "revenue_usd_m", "operating_income_usd_m",
  // "capex_total"). Enables dynamic "sort by <specific metric>"
  // options in the watchlist filter popover.
  latestMetrics?: Record<
    string,
    {
      value: number;
      unit: string | null;
      surprisePct: number | null;
      label: string;
      // true when the metric had BOTH sides but sanitize-basis cleared
      // surprisePct because they came from incompatible accounting
      // bases (e.g. SEC GAAP actual vs Yahoo adjusted-EPS consensus).
      // Optional so older index files parse cleanly.
      crossBasisCleared?: boolean;
    }
  >;
  // These three are populated by the builders but not consumed by any
  // renderer of a WatchlistRow (guidanceMove renders on event-detail
  // reading its own event.guidanceMove). Optional so callers can skip
  // populating them; kept for backwards compatibility.
  guidanceMove?: GuidanceMove;
  reactionSpark?: number[]; // 4 values, one per horizon, null-safe
  reactionPending?: boolean;
  // Full reaction horizons on the latest past event — populated by the
  // index builder so the compact <ReactionRow /> can render on the
  // sector row + watchlist expanded row without touching the shard.
  reactionPoints?: WatchlistReactionPoint[];
  freshness: Freshness;
  sourceCount: number;
  // Client compares this against localStorage lastSeenAt[ticker] to
  // decide whether to render the "new since visit" badge. Server
  // never renders based on this — only the client knows what has
  // been seen. Absent when no source items exist yet.
  latestItemAt?: string;
  // DEPRECATED — the old fake heuristic (min(sourceCount, 2)). Kept
  // on the type for one deploy so the row builders don't fail; the
  // WatchlistTable now computes the "new" state client-side from
  // latestItemAt + localStorage. Remove in a follow-up.
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
  // Y/Y revenue growth on the latest reported quarter. Computed by
  // shard-earnings.mjs when both the latest and same-quarter-prior
  // events carry revenue_usd_m actuals. Fills the Beat/miss column
  // when the same-basis surprise isn't available (most SP500 rows,
  // since Yahoo doesn't publish revenue estimates for most tickers
  // and the EPS estimate is adjusted-basis vs SEC GAAP actual).
  yoyRevenueGrowthPct?: number | null;
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
  // ISO time of the most recent source item on ANY of this ticker's
  // events. Populated by shard-earnings.mjs as max(item.time) across
  // all events' sources.items[]. Client uses this vs a localStorage
  // lastSeenAt[ticker] to compute the "+N new since visit" badge —
  // avoids shipping the full item list to the grid just for a
  // freshness comparison.
  latestItemAt?: string;
  // Forward-growth signal — % change from the latest past event's
  // ACTUAL to the next upcoming event's ANALYST ESTIMATE for the
  // same metric. Prefers revenue_usd_m, falls back to eps_usd.
  // Positive → analysts expect growth q/q. Consumed by the ranking
  // script (data/ranking.json) as one of three composite-score
  // components. Absent when either side is missing.
  nextEstimateVsActualPct?: number;
  // Which metric fed nextEstimateVsActualPct — audit hint so the
  // ranking output can label its source cleanly.
  nextEstimateBasis?: "revenue_usd_m" | "eps_usd";
  guidanceMove: GuidanceMove;
  freshness: Freshness;
  // Reaction horizons on the latest past event — carried in the index
  // so the sector member rows + watchlist expanded row can render a
  // compact ReactionRow without loading the full shard. Undefined when
  // the last event has no reaction points (developer / etf / not-yet
  // -matured shells).
  lastEventReactionPoints?: ReactionPoint[];
  // Per-metric snapshot of the latest event carried in the index so
  // the watchlist's "Industry-specific metric" column selector +
  // dynamic per-metric sort can read directly (no shard fetch).
  // Populated by shard-earnings.mjs from latest.metrics[]. Keyed by
  // metric.key (e.g. "revenue_usd_m", "capex_total", "production_cu_kt").
  latestMetrics?: Record<
    string,
    {
      value: number;
      unit: string | null;
      surprisePct: number | null;
      label: string;
      // true when the metric had BOTH sides but sanitize-basis cleared
      // surprisePct because they came from incompatible accounting
      // bases (e.g. SEC GAAP actual vs Yahoo adjusted-EPS consensus).
      // Optional so older index files parse cleanly.
      crossBasisCleared?: boolean;
    }
  >;
}

export interface EventsIndex {
  schema: "events-index/v1";
  updatedAt: string;
  entries: EventsIndexEntry[];
}

// User-editable preferences. Separate from `watchlist` (which is the
// tracked set, populated by admin/expand flow) — `focusTickers` is the
// prioritized subset the user actively cares about within that set,
// used to filter/rank the overview. Themes live here so subsequent
// Feature 2/3 features can key off the same object.
// Feature 3A — mechanical composite ranking output. Written by
// scripts/run-ranking.mjs; rendered by /ideas. Components ride along
// on every row so the UI can defend a ranking by pointing at inputs.
export interface RankingRow {
  ticker: string;
  displayName: string;
  capTier: CapTier;
  period: string | null;
  eventDate: string;
  composite: number;
  components: {
    reaction: {
      absReturn: number | null;
      excessReturn: number | null;
      score: number;
    };
    surprise: {
      pct: number | null;
      score: number;
    };
  };
}

export interface Ranking {
  schema: "ranking/v1";
  generatedAt: string;
  windowDays: number;
  universeSize: number;
  filteredSplitArtifacts: number;
  weights: { reaction: number; surprise: number };
  caps: { reactionAbsReturn: number; surpriseAbsPct: number };
  rows: RankingRow[];
}

export interface Preferences {
  focusTickers: string[];
  themes: Array<{ id: string; label: string; active: boolean }>;
  subscriptions: {
    newTranscripts: boolean;
    weekAhead: boolean;
    ideasDigest: boolean;
  };
  // Rolling last-visit timestamps for the "new since your last visit"
  // badge. Two-slot design avoids the "everything is new on first
  // load" bug: the CURRENT visit only becomes the cutoff on the NEXT
  // visit. `previous` is the cutoff shown as "new since <this time>";
  // `current` is stamped on load and becomes `previous` next time.
  // Both may be null before the user has visited (badges suppressed).
  lastVisit?: {
    previous: string | null; // ISO — cutoff used to render "new" badges
    current: string | null;  // ISO — when the current session started
  };
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
  // Legacy top-level themes kept during migration. Read path prefers
  // `preferences.themes` when present. Follow-up commit drops this
  // once the deployed snapshot has been through one write with the
  // new envelope.
  themes: Array<{ id: string; label: string; active: boolean }>;
  preferences?: Preferences;
  lastCommit: string;
}

// Post-earnings summary written by the /earnings + /sweep slash
// commands. One file per ticker+period at
// data/summaries/<TICKER>_<PERIOD>.json. Ledger discipline: every
// figure comes from the primary document or our SEC-verbatim shard
// metrics — never aggregators, never "vs consensus". Schema is
// mirrored in data/summaries-schema.json (validator enforces).
export type SummaryDeltaBasis = "q/q" | "y/y" | "vs guidance" | "none";
export type SummaryDirection = "up" | "down" | "flat" | "n/a";

export interface SummaryKpi {
  label: string;
  value: string; // formatted with unit ("$757.3M", "US$2.63/lb")
  delta: string | null; // null iff delta_basis === "none"
  delta_basis: SummaryDeltaBasis;
  direction: SummaryDirection;
}

// v2 addition — per-KPI (or overall) cause explanation grounded in
// the primary document. See data/summaries-schema.json for the full
// contract; the essential invariant is that `explanation` is either
// a company-disclosed cause (majority) or a mechanical arithmetic
// decomposition — never analyst theorising, never a macro narrative.
// "not explained in the release" is a valid explanation and gets
// muted styling in the UI so its absence is visible.
export type SummaryDriverBasis = "company-disclosed" | "derived-arithmetic";
export interface SummaryDriver {
  metric: string; // matches a kpi.label or the literal "overall"
  direction: Exclude<SummaryDirection, "n/a">;
  explanation: string; // ≤50 words, no verbatim >15 words
  basis: SummaryDriverBasis;
}

// v3 addition — verbatim call-snippet quotes extracted from the
// earnings call transcript (or the release when no transcript is
// available). Each snippet stands on its own; UI renders them as
// pull-quotes under the summary. Contract:
//   - `quote` is a verbatim excerpt, ≤ 45 words, no ellipsis-hiding.
//   - `speaker` is the person who said it (CEO/CFO/analyst name).
//     Empty string when the source is a written release rather
//     than a call.
//   - `role` is either "prepared" (management remarks / script) or
//     "qa" (Q&A section). Absent when unknown.
//   - `topic` is a short two-word-max theme label (e.g. "margins",
//     "guidance", "china"). Used for chip grouping.
//   - `source.url` links to the transcript / release; `source.locator`
//     is optional deep-link (#seg-N or #para-N) matching the
//     Document ingest pattern.
export type SummaryCallSnippetRole = "prepared" | "qa";
export interface SummaryCallSnippet {
  quote: string;
  speaker: string;
  role?: SummaryCallSnippetRole;
  topic: string;
  source: {
    url: string;
    locator?: string;
  };
}

export interface Summary {
  ticker: string;
  period: string;
  reported_at: string; // YYYY-MM-DD
  generated_at: string; // ISO-8601
  headline: string;
  kpis: SummaryKpi[];
  summary_short: string;
  summary_long: string;
  source_url: string;
  confidence_notes: string;
  // Optional — absent in v1 files, present in v2. Backward-compat
  // logic: any consumer must render nothing when the field is
  // missing rather than fall over.
  drivers?: SummaryDriver[];
  // v3 addition — verbatim call quotes. Optional (absent for
  // pre-v3 summaries + for events with no transcript on record).
  callSnippets?: SummaryCallSnippet[];
  // Summary depth. "filing" = full treatment (release / 10-Q read,
  // drivers + guidance assessed). "kpi-only" = fast path composed
  // purely from resolve-earnings-target.mjs output (SEC-verbatim
  // shard KPIs + deltas; no web/doc fetch). Absent → default "filing"
  // for backward compat with v1 + early-v2 files.
  depth?: "filing" | "kpi-only";
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
