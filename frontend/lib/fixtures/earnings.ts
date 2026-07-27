import type { EarningsSnapshot, EventRecord, Fact } from "@/lib/types";

// Helper to make Facts compact
function f(
  value: number | null,
  unit: string,
  opts: Partial<Fact> = {},
): Fact {
  return {
    value,
    unit,
    source: opts.source ?? {
      url: "#",
      label: "Company IR press release",
      provenance: "ir-page",
      locator: null,
    },
    asOf: opts.asOf ?? "2026-07-23",
    fetchedAt: opts.fetchedAt ?? "2026-07-24T06:04:00Z",
    method: opts.method ?? "filing_manual",
    confidence: opts.confidence ?? 1.0,
  };
}

// A MISS event with a partial source window and one engine down
const capstoneQ1: EventRecord = {
  id: "CS_CN_2026Q1",
  ticker: "CS CN",
  kind: "earnings",
  period: "FY2026 Q1",
  scheduledDate: "2026-05-06",
  eventDate: "2026-05-06",
  timing: "AMC",
  expectation: "below",
  guidanceMove: "held",
  freshness: "fresh",
  metrics: [
    {
      key: "production_cu_kt",
      displayLabel: "Copper production",
      isHeadline: true,
      surprisePct: -4.2,
      estimate: f(52.0, "kt", { method: "fmp" }),
      actual: f(49.8, "kt"),
    },
    {
      key: "c1_usd_lb",
      displayLabel: "C1 cash cost",
      isHeadline: true,
      surprisePct: -6.5,
      estimate: f(2.15, "USD/lb", { method: "bloomberg_manual" }),
      actual: f(2.29, "USD/lb"),
    },
    {
      key: "ebitda_usd_m",
      displayLabel: "EBITDA",
      isHeadline: true,
      surprisePct: null, // n/a — no estimate
      estimate: null,
      actual: f(118, "USD_m"),
    },
  ],
  guidance: [
    {
      key: "production_cu_kt",
      displayLabel: "FY production",
      period: "FY2026",
      basis: "midpoint",
      version: 1,
      supersededById: null,
      move: "held",
      low: f(220, "kt"),
      high: f(240, "kt"),
      midpoint: f(230, "kt"),
    },
  ],
  reaction: {
    benchmark: "HG=F",
    baselineDate: "2026-05-07",
    baselineClose: 6.85,
    points: [
      {
        horizon: "d1",
        absReturn: -0.028,
        excessReturn: -0.019,
        benchmark: "HG=F",
        computedAt: "2026-05-08T21:00:00Z",
      },
      {
        horizon: "d3",
        absReturn: -0.041,
        excessReturn: -0.026,
        benchmark: "HG=F",
        computedAt: "2026-05-11T21:00:00Z",
        gapFlagged: true,
      },
      {
        horizon: "w1",
        absReturn: -0.019,
        excessReturn: 0.004,
        benchmark: "HG=F",
        computedAt: "2026-05-14T21:00:00Z",
      },
      {
        horizon: "m1",
        absReturn: 0.032,
        excessReturn: 0.011,
        benchmark: "HG=F",
        computedAt: "2026-06-08T21:00:00Z",
      },
    ],
  },
  sources: {
    windowStart: "2026-05-04",
    windowEnd: "2026-06-10",
    capturedAt: "2026-05-15T06:00:00Z",
    items: [
      {
        id: "cs1",
        url: "https://capstonecopper.example/q1-2026",
        headline:
          "Capstone Copper Q1 2026 results — Mantoverde ramp continues",
        source: "Capstone IR",
        provenance: "ir-page",
        time: "2026-05-06T21:00:00Z",
        articleType: "news",
        engine: "ir-rss",
        language: "en",
        hosted: true,
        summary: null,
      },
      {
        id: "cs2",
        url: "https://newswire.example/cs-cn-8k",
        headline: "SEDAR+ MD&A — Q1 2026",
        source: "SEDAR+",
        provenance: "regulatory",
        time: "2026-05-06T21:15:00Z",
        articleType: "news",
        engine: "newsfile",
        language: "en",
        hosted: false,
        summary: null,
      },
      {
        id: "cs3",
        url: "https://mining-news.example/cu-outlook",
        headline: "Copper miners: cost inflation biting into 2026 guidance",
        source: "Mining Weekly",
        provenance: "news",
        time: "2026-05-07T13:00:00Z",
        articleType: "opinion",
        engine: "google",
        language: "en",
        hosted: false,
        summary: null,
      },
    ],
    engineStatus: [
      { engine: "google", ok: true },
      { engine: "bing", ok: true },
      { engine: "gdelt", ok: true },
      { engine: "ir-rss", ok: true },
      { engine: "twitter", ok: false, lastGood: "2026-05-06T05:41:00Z" }, // proxy down
      { engine: "newsfile", ok: true },
    ],
  },
};

// A DEVELOPER catalyst — SCMI (Sonoro Metals) PEA release
const sonoroPEA: EventRecord = {
  id: "SCMI_CN_PEA_2026",
  ticker: "SCMI CN",
  kind: "catalyst",
  period: "PEA 2026",
  scheduledDate: "2026-09-15",
  eventDate: null,
  timing: null,
  catalystType: "PEA",
  expectation: "unset",
  guidanceMove: null,
  freshness: "overdue",
  metrics: [],
  guidance: [],
  catalysts: [
    {
      type: "PEA",
      title: "Cerro Caliche Preliminary Economic Assessment",
      expectedDate: "2026-09-15",
      actualDate: null,
      expectation: "unset",
      keyValues: [
        { label: "Expected NPV(5%)", value: "US$ 180–220M" },
        { label: "Expected IRR", value: "26–34%" },
        { label: "Resource (est.)", value: "1.6–1.9 Moz AuEq" },
      ],
      source: {
        url: "#",
        label: "Analyst estimate · manual",
        provenance: "independent",
        locator: null,
      },
    },
  ],
  reaction: {
    benchmark: "GC=F",
    baselineDate: null,
    baselineClose: null,
    points: [
      {
        horizon: "d1",
        absReturn: null,
        excessReturn: null,
        benchmark: "GC=F",
        computedAt: null,
        populatesOn: "2026-09-16",
      },
      {
        horizon: "d3",
        absReturn: null,
        excessReturn: null,
        benchmark: "GC=F",
        computedAt: null,
        populatesOn: "2026-09-18",
      },
      {
        horizon: "w1",
        absReturn: null,
        excessReturn: null,
        benchmark: "GC=F",
        computedAt: null,
        populatesOn: "2026-09-22",
      },
      {
        horizon: "m1",
        absReturn: null,
        excessReturn: null,
        benchmark: "GC=F",
        computedAt: null,
        populatesOn: "2026-10-15",
      },
    ],
  },
  sources: {
    windowStart: "2026-09-13",
    windowEnd: "2026-10-20",
    capturedAt: null,
    items: [], // empty window — the design system's empty-state case
    engineStatus: [
      { engine: "google", ok: true },
      { engine: "bing", ok: true },
      { engine: "gdelt", ok: true },
      { engine: "ir-rss", ok: true },
    ],
  },
};

export const EARNINGS_FIXTURE: EarningsSnapshot = {
  schema: "earnings/v1",
  lastUpdated: "2026-07-24T06:04:00Z",
  events: [capstoneQ1, sonoroPEA],
};

export function getEventsForTicker(ticker: string): EventRecord[] {
  return EARNINGS_FIXTURE.events.filter((e) => e.ticker === ticker);
}

export function getEvent(eventId: string): EventRecord | undefined {
  return EARNINGS_FIXTURE.events.find((e) => e.id === eventId);
}

export function getLatestEvent(ticker: string): EventRecord | undefined {
  const list = getEventsForTicker(ticker);
  return list.sort((a, b) =>
    (b.eventDate ?? b.scheduledDate).localeCompare(
      a.eventDate ?? a.scheduledDate,
    ),
  )[0];
}
