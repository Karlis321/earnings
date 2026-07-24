// Central data seam — every route reads through this. P3 replaces the
// FIXTURE_MODE branch with live fetches to /api/earnings, /api/shared-state, etc.
// Backend integration flag: the `live` branch below is where P3-T1 wires up.

import { EARNINGS_FIXTURE, getEvent, getEventsForTicker } from "./fixtures/earnings";
import {
  DISCOVER_FEED_SAMPLES,
  FEEDBACK_LOG,
  SHARED_STATE,
} from "./fixtures/sharedState";
import { ETF_DETAILS } from "./fixtures/etf";
import {
  ENTITY_REGISTRY,
  getEntitiesInSector,
  getEntity,
  getSectors,
} from "./fixtures/registry";
import { buildWatchlist } from "./watchlist";

export const FIXTURE_MODE = true; // P3 flips to env-flag

export const data = {
  // registry
  listEntities: () => ENTITY_REGISTRY,
  getEntity,
  getSectors,
  getEntitiesInSector,

  // watchlist / overview
  getWatchlist: () => buildWatchlist(),
  getSharedState: () => SHARED_STATE,

  // events
  getEventsForTicker,
  getEvent,
  getSnapshot: () => EARNINGS_FIXTURE,
  getLatestEventFor: (ticker: string) =>
    EARNINGS_FIXTURE.events
      .filter((e) => e.ticker === ticker)
      .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate))[0],

  // etf
  getEtfDetail: (ticker: string) => ETF_DETAILS[ticker],

  // admin
  discoverFeed: (input: string) => {
    const match = DISCOVER_FEED_SAMPLES.find((d) => d.input === input);
    return match?.result ?? {
      kind: "site-filter" as const,
      url: `https://news.google.com/search?q=site%3A${input}`,
      title: `Google News · site:${input}`,
      note: "No RSS detected · site-filter fallback",
    };
  },
  getFeedback: () => FEEDBACK_LOG,
};
