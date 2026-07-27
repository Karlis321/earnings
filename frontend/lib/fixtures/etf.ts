import type { EtfDetail } from "@/lib/types";

// ETF fixture data — GDXJ US, XEG CN, RIO FP.
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
  "XEG CN": {
    price: {
      value: 17.86,
      unit: "CAD",
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
      { exDate: "2026-06-24", amount: 0.12, currency: "CAD", yieldPct: 2.6 },
      { exDate: "2026-03-24", amount: 0.11, currency: "CAD", yieldPct: 2.4 },
      { exDate: "2025-12-19", amount: 0.14, currency: "CAD", yieldPct: 3.0 },
    ],
    holdings: [
      {
        ticker: "CNQ CN",
        name: "Canadian Natural Resources",
        weight: 24.1,
        asOf: "2026-07-23",
      },
      {
        ticker: "SU CN",
        name: "Suncor Energy",
        weight: 21.6,
        asOf: "2026-07-23",
      },
      {
        ticker: "CVE CN",
        name: "Cenovus Energy",
        weight: 9.8,
        asOf: "2026-07-23",
      },
      {
        ticker: "IMO CN",
        name: "Imperial Oil",
        weight: 6.4,
        asOf: "2026-07-23",
      },
      {
        ticker: "TOU CN",
        name: "Tourmaline Oil",
        weight: 5.2,
        asOf: "2026-07-23",
      },
    ],
    usedAsBenchmarkFor: [],
  },
  "RIO FP": {
    price: {
      value: 27.42,
      unit: "EUR",
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
      { exDate: "2025-12-19", amount: 0.38, currency: "EUR", yieldPct: 1.4 },
    ],
    holdings: [
      { ticker: "VALE3", name: "Vale", weight: 11.3, asOf: "2026-07-23" },
      { ticker: "PETR4", name: "Petrobras PN", weight: 9.7, asOf: "2026-07-23" },
      { ticker: "ITUB4", name: "Itaú Unibanco", weight: 7.2, asOf: "2026-07-23" },
      {
        ticker: "BBAS3",
        name: "Banco do Brasil",
        weight: 4.6,
        asOf: "2026-07-23",
      },
    ],
    usedAsBenchmarkFor: [],
  },
};
