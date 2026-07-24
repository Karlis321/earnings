import { ENTITY_REGISTRY } from "./registry";

// shared-state.json shape (per PRD §9 / Appendix A.11).
// Watchlist = every core entity; custom sources + themes editable at admin.
export const SHARED_STATE = {
  watchlist: ENTITY_REGISTRY.filter((e) => e.isCore).map((e) => e.ticker),
  customSources: [
    {
      id: "cs-substack-1",
      kind: "substack" as const,
      url: "https://coppercompendium.substack.com",
      title: "The Copper Compendium",
      scope: { tickers: ["CS CN", "HBM CN", "TGB CN"], themes: ["copper"] },
      addedAt: "2026-06-12T09:12:00Z",
      active: true,
    },
    {
      id: "cs-x-1",
      kind: "twitter" as const,
      url: "https://x.com/semianalyst",
      title: "@semianalyst",
      scope: { tickers: ["INTC US", "NVDA US"], themes: ["semiconductors"] },
      addedAt: "2026-05-30T14:03:00Z",
      active: true,
    },
    {
      id: "cs-rss-1",
      kind: "rss" as const,
      url: "https://miningweekly.example/rss",
      title: "Mining Weekly · headlines",
      scope: { tickers: [], themes: ["copper", "gold", "mining"] },
      addedAt: "2026-04-02T11:41:00Z",
      active: true,
    },
  ],
  themes: [
    { id: "copper", label: "Copper", active: true },
    { id: "gold", label: "Gold", active: true },
    { id: "semiconductors", label: "Semiconductors", active: true },
    { id: "uranium", label: "Uranium", active: true },
  ],
  lastCommit: "2026-07-24T06:04:00Z",
};

export const FEEDBACK_LOG = [
  {
    id: "fb-1",
    target: "item" as const,
    targetId: "s3",
    action: "not_relevant" as const,
    createdBy: "toms@bluor",
    createdAt: "2026-07-24T09:12:00Z",
  },
  {
    id: "fb-2",
    target: "source" as const,
    targetId: "mining-news.example",
    action: "thumbs_down" as const,
    createdBy: "toms@bluor",
    createdAt: "2026-05-08T10:04:00Z",
  },
];

export const DISCOVER_FEED_SAMPLES = [
  {
    input: "https://coppercompendium.substack.com",
    result: {
      kind: "substack" as const,
      url: "https://coppercompendium.substack.com/feed",
      title: "The Copper Compendium",
      note: "Substack profile · full-text RSS available",
    },
  },
  {
    input: "https://www.wsj.com/articles/example",
    result: {
      kind: "site-filter" as const,
      url: "https://news.google.com/search?q=site%3Awsj.com",
      title: "Google News · site:wsj.com",
      note: "Major publisher · routed to site-filter fallback",
    },
  },
  {
    input: "https://x.com/semianalyst",
    result: {
      kind: "twitter" as const,
      url: "nitter://semianalyst",
      title: "@semianalyst",
      note: "X account · proxied via Nitter",
    },
  },
  {
    input: "https://private.corp.internal/feed",
    result: {
      kind: "rejected" as const,
      url: "https://private.corp.internal/feed",
      note: "Private host — rejected",
    },
  },
];
