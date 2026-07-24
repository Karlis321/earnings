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

// A fully-populated operating BEAT event — Intel Q2 2026 (matches design mockup)
const intelQ2: EventRecord = {
  id: "INTC_US_2026Q2",
  ticker: "INTC US",
  kind: "earnings",
  period: "FY2026 Q2",
  scheduledDate: "2026-07-24",
  eventDate: "2026-07-24",
  timing: "AMC",
  expectation: "above",
  guidanceMove: "raised",
  freshness: "fresh",
  metrics: [
    {
      key: "revenue_usd_m",
      displayLabel: "Revenue",
      isHeadline: true,
      surprisePct: 11.6,
      estimate: f(14400, "USD_m", {
        source: {
          url: "#",
          label: "Bloomberg consensus",
          provenance: "wire",
          locator: null,
        },
        method: "bloomberg_manual",
        asOf: "2026-07-23",
      }),
      actual: f(16100, "USD_m", {
        source: {
          url: "#/press-release#revenue",
          label: "Intel Q2 press release · para 4",
          provenance: "ir-page",
          locator: "para-4",
        },
      }),
    },
    {
      key: "ebitda_usd_m",
      displayLabel: "EBITDA",
      isHeadline: true,
      surprisePct: 31.9,
      estimate: f(4540, "USD_m", { method: "fmp", asOf: "2026-07-22" }),
      actual: f(5990, "USD_m"),
    },
    {
      key: "eps_usd",
      displayLabel: "EPS (adj.)",
      isHeadline: true,
      surprisePct: -12.5,
      estimate: f(0.48, "USD", { method: "fmp" }),
      actual: f(0.42, "USD"),
    },
  ],
  guidance: [
    {
      key: "revenue_usd_m",
      displayLabel: "FY revenue",
      period: "FY2026",
      basis: "reported",
      version: 2,
      supersededById: null,
      move: "raised",
      low: f(62000, "USD_m", { asOf: "2026-07-24" }),
      high: f(65000, "USD_m", { asOf: "2026-07-24" }),
      midpoint: f(63500, "USD_m", { asOf: "2026-07-24" }),
    },
    {
      key: "revenue_usd_m",
      displayLabel: "FY revenue (prior)",
      period: "FY2026",
      basis: "reported",
      version: 1,
      supersededById: "v2",
      move: "initiated",
      low: f(58000, "USD_m", { asOf: "2026-04-24" }),
      high: f(62000, "USD_m", { asOf: "2026-04-24" }),
      midpoint: f(60000, "USD_m", { asOf: "2026-04-24" }),
    },
  ],
  reaction: {
    benchmark: "SOX",
    baselineDate: "2026-07-24",
    baselineClose: 42.15,
    points: [
      {
        horizon: "d1",
        absReturn: 0.032,
        excessReturn: 0.021,
        benchmark: "SOX",
        computedAt: "2026-07-25T21:00:00Z",
      },
      {
        horizon: "d3",
        absReturn: 0.041,
        excessReturn: 0.028,
        benchmark: "SOX",
        computedAt: "2026-07-27T21:00:00Z",
      },
      {
        horizon: "w1",
        absReturn: 0.055,
        excessReturn: 0.036,
        benchmark: "SOX",
        computedAt: "2026-07-31T21:00:00Z",
      },
      {
        horizon: "m1",
        absReturn: null,
        excessReturn: null,
        benchmark: "SOX",
        computedAt: null,
        populatesOn: "2026-08-24",
      },
    ],
  },
  sources: {
    windowStart: "2026-07-22",
    windowEnd: "2026-08-28",
    capturedAt: "2026-07-25T06:00:00Z",
    items: [
      {
        id: "s1",
        url: "https://reuters.example/intc-lifts-outlook",
        headline: "Intel lifts full-year outlook after data-center rebound",
        source: "Reuters",
        provenance: "wire",
        time: "2026-07-24T22:14:00Z",
        articleType: "news",
        engine: "google",
        language: "en",
        hosted: false,
        summary: null,
      },
      {
        id: "s2",
        url: "https://intel.example/press-q2-2026",
        headline: "Intel reports second quarter 2026 financial results",
        source: "Intel IR",
        provenance: "ir-page",
        time: "2026-07-24T20:01:00Z",
        articleType: "news",
        engine: "ir-rss",
        language: "en",
        hosted: true,
        summary: null,
      },
      {
        id: "s3",
        url: "https://bloombergopinion.example/intc-priced-in",
        headline: "Intel's beat is real. The re-rating is not yet",
        source: "Bloomberg Opinion",
        provenance: "news",
        time: "2026-07-24T23:30:00Z",
        articleType: "opinion",
        engine: "bing",
        language: "en",
        hosted: false,
        summary: null,
      },
      {
        id: "s4",
        url: "https://twitter.example/analyst/status/x",
        headline: "$INTC full-year raise is above the top of consensus range",
        source: "@semianalyst",
        provenance: "social",
        time: "2026-07-24T22:40:00Z",
        articleType: "opinion",
        engine: "twitter",
        language: "en",
        hosted: false,
        summary: null,
        engagement: { likes: 412, reposts: 78, replies: 21 },
      },
    ],
    engineStatus: [
      { engine: "google", ok: true },
      { engine: "bing", ok: true },
      { engine: "gdelt", ok: true },
      { engine: "ir-rss", ok: true },
      { engine: "twitter", ok: true },
      { engine: "edgar", ok: true },
    ],
  },
  verdictNote:
    "Raise came in above street. Watch the DC gross-margin trajectory in Q3.",
};

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

// A recent-but-partial-reaction event — NVDA (pending +1m)
const nvdaQ1: EventRecord = {
  id: "NVDA_US_2027Q1",
  ticker: "NVDA US",
  kind: "earnings",
  period: "FY2027 Q1",
  scheduledDate: "2026-07-22",
  eventDate: "2026-07-22",
  timing: "AMC",
  expectation: "above",
  guidanceMove: "raised",
  freshness: "fresh",
  metrics: [
    {
      key: "revenue_usd_m",
      displayLabel: "Revenue",
      isHeadline: true,
      surprisePct: 6.8,
      estimate: f(38200, "USD_m", { method: "fmp" }),
      actual: f(40800, "USD_m"),
    },
    {
      key: "data_center_rev_usd_m",
      displayLabel: "Data-center revenue",
      isHeadline: true,
      surprisePct: 9.4,
      estimate: f(30500, "USD_m", { method: "fmp" }),
      actual: f(33380, "USD_m"),
    },
    {
      key: "eps_usd",
      displayLabel: "EPS",
      isHeadline: true,
      surprisePct: 8.2,
      estimate: f(0.61, "USD", { method: "fmp" }),
      actual: f(0.66, "USD"),
    },
  ],
  guidance: [
    {
      key: "revenue_usd_m",
      displayLabel: "Next-Q revenue",
      period: "FY2027 Q2",
      basis: "midpoint",
      version: 1,
      supersededById: null,
      move: "raised",
      low: f(43500, "USD_m"),
      high: f(45500, "USD_m"),
      midpoint: f(44500, "USD_m"),
    },
  ],
  reaction: {
    benchmark: "SOX",
    baselineDate: "2026-07-22",
    baselineClose: 168.4,
    points: [
      {
        horizon: "d1",
        absReturn: 0.028,
        excessReturn: 0.019,
        benchmark: "SOX",
        computedAt: "2026-07-23T21:00:00Z",
      },
      {
        horizon: "d3",
        absReturn: null,
        excessReturn: null,
        benchmark: "SOX",
        computedAt: null,
        populatesOn: "2026-07-25",
      },
      {
        horizon: "w1",
        absReturn: null,
        excessReturn: null,
        benchmark: "SOX",
        computedAt: null,
        populatesOn: "2026-07-29",
      },
      {
        horizon: "m1",
        absReturn: null,
        excessReturn: null,
        benchmark: "SOX",
        computedAt: null,
        populatesOn: "2026-08-22",
      },
    ],
  },
  sources: {
    windowStart: "2026-07-20",
    windowEnd: "2026-08-26",
    capturedAt: "2026-07-24T06:00:00Z",
    items: [
      {
        id: "nvda1",
        url: "https://nvidianews.example/q1-2027",
        headline: "NVIDIA reports Q1 FY27 revenue of $40.8B, up 62% YoY",
        source: "NVIDIA IR",
        provenance: "ir-page",
        time: "2026-07-22T20:05:00Z",
        articleType: "news",
        engine: "ir-rss",
        language: "en",
        hosted: true,
        summary: null,
      },
      {
        id: "nvda2",
        url: "https://reuters.example/nvda-beat",
        headline: "NVIDIA beats and guides higher on hyperscaler demand",
        source: "Reuters",
        provenance: "wire",
        time: "2026-07-22T20:32:00Z",
        articleType: "news",
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
      { engine: "twitter", ok: true },
    ],
  },
};

export const EARNINGS_FIXTURE: EarningsSnapshot = {
  schema: "earnings/v1",
  lastUpdated: "2026-07-24T06:04:00Z",
  events: [intelQ2, capstoneQ1, sonoroPEA, nvdaQ1],
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
