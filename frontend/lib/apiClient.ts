// API client — reads flip to live via /api/*. Writes still local (W3+).
// Fixture fallback preserved for offline dev; live is the default now.

import { FEATURE_FLAGS } from "./flags";
import { data as F } from "./data";
import type {
  EarningsSnapshot,
  EventRecord,
  Entity,
  WatchlistRow,
  EtfDetail,
} from "./types";

const LIVE = true; // read endpoints live; writes still deferred

async function safeFetch<T>(path: string, fallback: () => T | Promise<T>): Promise<T> {
  if (!LIVE) return fallback();
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return (await r.json()) as T;
  } catch (e) {
    if (typeof window === "undefined") {
      // Server-side render: use fixture instantly
      return fallback();
    }
    throw e;
  }
}

export const api = {
  async getHealth() {
    return safeFetch("/api/health", () => ({
      ok: true,
      snapshotAt: F.getSnapshot().lastUpdated,
      schema: F.getSnapshot().schema,
      events: F.getSnapshot().events.length,
      mode: "fixture",
      ghPatPresent: false,
    }));
  },

  async getSharedState() {
    return safeFetch("/api/shared-state", () => F.getSharedState());
  },

  async getEntities(): Promise<Entity[]> {
    return safeFetch("/api/entity-registry", () => ({
      schema: "entity-registry/v1",
      entities: F.listEntities(),
    })).then((r: unknown) => {
      const wrapped = r as { entities?: Entity[] };
      return wrapped.entities ?? (r as Entity[]);
    });
  },

  async getDictionary() {
    return safeFetch("/api/metric-dictionary", () => ({
      schema: "metric-dictionary/v1" as const,
      metrics: {},
    }));
  },

  async getWatchlist(): Promise<WatchlistRow[]> {
    // Client-side derivation from the entity registry + snapshot.
    // No dedicated backend endpoint for this — it's a join over two.
    return F.getWatchlist();
  },

  async getEventsForTicker(ticker: string): Promise<EventRecord[]> {
    const r = await safeFetch<{ events?: EventRecord[]; type?: string }>(
      `/api/earnings?ticker=${encodeURIComponent(ticker)}`,
      () => ({ events: F.getEventsForTicker(ticker), type: "operating" }),
    );
    return r.events ?? [];
  },

  async getEvent(eventId: string): Promise<EventRecord | undefined> {
    if (!LIVE) return F.getEvent(eventId);
    try {
      const r = await fetch(
        `/api/earnings?event=${encodeURIComponent(eventId)}`,
        { cache: "no-store" },
      );
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`event fetch ${r.status}`);
      return (await r.json()) as EventRecord;
    } catch {
      return F.getEvent(eventId);
    }
  },

  async getSnapshot(): Promise<EarningsSnapshot> {
    return safeFetch("/api/earnings/snapshot", () => F.getSnapshot());
  },

  async getEtfDetail(ticker: string): Promise<EtfDetail | undefined> {
    try {
      const r = await fetch(
        `/api/earnings?ticker=${encodeURIComponent(ticker)}`,
        { cache: "no-store" },
      );
      if (!r.ok) return F.getEtfDetail(ticker);
      const j = (await r.json()) as {
        type?: string;
        etf?: EtfDetail | null;
      };
      return j.etf ?? undefined;
    } catch {
      return F.getEtfDetail(ticker);
    }
  },

  async getFeedback() {
    return safeFetch("/api/feedback", () => ({
      schema: "feedback/v1",
      entries: F.getFeedback(),
    }));
  },

  // Writes still fixture-only until W3.
  async refreshSources(_eventId: string): Promise<{ appended: number }> {
    if (FEATURE_FLAGS.liveMode) {
      throw new Error("Refresh-sources — W5 backend not yet wired");
    }
    return { appended: 0 };
  },

  async postFeedback(_target: string, _action: string): Promise<{ ok: true }> {
    if (FEATURE_FLAGS.liveMode) {
      throw new Error("Feedback write — W3 backend not yet wired");
    }
    return { ok: true as const };
  },

  async discoverFeed(input: string) {
    return F.discoverFeed(input);
  },
};
