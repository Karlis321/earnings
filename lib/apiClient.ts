// P3-T1: API client wrapper with fixtures-vs-live switch.
// Every view reads through these — flipping FEATURE_FLAGS.liveMode swaps
// the fixture branch for real fetches. All 🔴 backend tasks in the
// Backend Dependency Register live here.

import { FEATURE_FLAGS } from "./flags";
import { data as F } from "./data";
import type {
  EarningsSnapshot,
  EventRecord,
  Entity,
  WatchlistRow,
  EtfDetail,
} from "./types";

async function fromFixture<T>(v: T): Promise<T> {
  // simulate a small async so components using startTransition behave live-like
  return v;
}

export const api = {
  async getSharedState() {
    if (FEATURE_FLAGS.liveMode) {
      // BACKEND: GET /api/shared-state
      throw new Error("Live mode not yet wired · P3 backend dep");
    }
    return fromFixture(F.getSharedState());
  },

  async getEntities(): Promise<Entity[]> {
    if (FEATURE_FLAGS.liveMode) {
      // BACKEND: entity-registry.json served
      throw new Error("Live mode not yet wired");
    }
    return fromFixture(F.listEntities());
  },

  async getWatchlist(): Promise<WatchlistRow[]> {
    if (FEATURE_FLAGS.liveMode) {
      // BACKEND: /api/shared-state + /api/earnings joined per ticker
      throw new Error("Live mode not yet wired");
    }
    return fromFixture(F.getWatchlist());
  },

  async getEventsForTicker(ticker: string): Promise<EventRecord[]> {
    if (FEATURE_FLAGS.liveMode) {
      // BACKEND: /api/earnings?ticker=...
      throw new Error("Live mode not yet wired");
    }
    return fromFixture(F.getEventsForTicker(ticker));
  },

  async getEvent(eventId: string): Promise<EventRecord | undefined> {
    if (FEATURE_FLAGS.liveMode) {
      // BACKEND: /api/earnings?event=...
      throw new Error("Live mode not yet wired");
    }
    return fromFixture(F.getEvent(eventId));
  },

  async getSnapshot(): Promise<EarningsSnapshot> {
    if (FEATURE_FLAGS.liveMode) {
      throw new Error("Live mode not yet wired");
    }
    return fromFixture(F.getSnapshot());
  },

  async getEtfDetail(ticker: string): Promise<EtfDetail | undefined> {
    return fromFixture(F.getEtfDetail(ticker));
  },

  // Refresh-sources action (P6-T5) — backend: /api/news + /api/press-releases + /api/tweets
  async refreshSources(_eventId: string): Promise<{ appended: number }> {
    if (FEATURE_FLAGS.liveMode) {
      throw new Error("Live mode not yet wired — refresh sources");
    }
    return fromFixture({ appended: 0 });
  },

  // Feedback (P6-T6, P8-T5) — backend: /api/feedback
  async postFeedback(_target: string, _action: string): Promise<{ ok: true }> {
    if (FEATURE_FLAGS.liveMode) {
      throw new Error("Live mode not yet wired — feedback");
    }
    return fromFixture({ ok: true as const });
  },

  // Discover feed (P8-T4) — backend: /api/discover-feed
  async discoverFeed(input: string) {
    return fromFixture(F.discoverFeed(input));
  },
};
