import type { EtfDetail } from "@/lib/types";

// ETF fixture data — GDXJ, COPX, URA.
// PRD §4.L: ETFs show price / distribution / holdings only; no events.
export const ETF_DETAILS: Record<string, EtfDetail> = {
  "GDXJ US": {
    price: {
      value: 63.12,
      unit: "USD",
      source: {
        url: "#",
        label: "Yahoo close",
        provenance: "wire",
        locator: null,
      },
      asOf: "2026-07-23",
      fetchedAt: "2026-07-24T06:04:00Z",
      method: "yahoo",
      confidence: 1,
    },
    distributions: [
      { exDate: "2026-06-24", amount: 0.42, currency: "USD", yieldPct: 1.6 },
      { exDate: "2026-03-24", amount: 0.39, currency: "USD", yieldPct: 1.5 },
      { exDate: "2025-12-19", amount: 0.51, currency: "USD", yieldPct: 1.8 },
    ],
    holdings: [
      {
        ticker: "PAAS",
        name: "Pan American Silver",
        weight: 6.2,
        asOf: "2026-07-23",
      },
      {
        ticker: "AGI",
        name: "Alamos Gold",
        weight: 5.8,
        asOf: "2026-07-23",
      },
      {
        ticker: "HMY",
        name: "Harmony Gold",
        weight: 4.9,
        asOf: "2026-07-23",
      },
      {
        ticker: "SSRM",
        name: "SSR Mining",
        weight: 4.3,
        asOf: "2026-07-23",
      },
      {
        ticker: "SILV CN",
        name: "SilverCrest",
        weight: 3.9,
        asOf: "2026-07-23",
      },
    ],
    usedAsBenchmarkFor: [],
  },
  "COPX US": {
    price: {
      value: 39.44,
      unit: "USD",
      source: {
        url: "#",
        label: "Yahoo close",
        provenance: "wire",
        locator: null,
      },
      asOf: "2026-07-23",
      fetchedAt: "2026-07-24T06:04:00Z",
      method: "yahoo",
      confidence: 1,
    },
    distributions: [
      { exDate: "2026-06-24", amount: 0.28, currency: "USD", yieldPct: 0.9 },
      { exDate: "2025-12-19", amount: 0.31, currency: "USD", yieldPct: 1.1 },
    ],
    holdings: [
      {
        ticker: "FCX",
        name: "Freeport-McMoRan",
        weight: 5.6,
        asOf: "2026-07-23",
      },
      {
        ticker: "BHP",
        name: "BHP Group",
        weight: 5.3,
        asOf: "2026-07-23",
      },
      {
        ticker: "CS CN",
        name: "Capstone Copper",
        weight: 4.7,
        asOf: "2026-07-23",
      },
      {
        ticker: "HBM CN",
        name: "Hudbay Minerals",
        weight: 4.4,
        asOf: "2026-07-23",
      },
    ],
    usedAsBenchmarkFor: [],
  },
  "URA US": {
    price: {
      value: 42.05,
      unit: "USD",
      source: {
        url: "#",
        label: "Yahoo close",
        provenance: "wire",
        locator: null,
      },
      asOf: "2026-07-23",
      fetchedAt: "2026-07-24T06:04:00Z",
      method: "yahoo",
      confidence: 1,
    },
    distributions: [
      { exDate: "2025-12-19", amount: 0.65, currency: "USD", yieldPct: 1.6 },
    ],
    holdings: [
      { ticker: "CCJ US", name: "Cameco", weight: 22.4, asOf: "2026-07-23" },
      { ticker: "OKLO", name: "Oklo Inc.", weight: 5.9, asOf: "2026-07-23" },
      {
        ticker: "KAP LI",
        name: "Kazatomprom",
        weight: 4.8,
        asOf: "2026-07-23",
      },
    ],
    usedAsBenchmarkFor: ["CCJ US"],
  },
};
