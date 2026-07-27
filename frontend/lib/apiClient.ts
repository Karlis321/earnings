// API client — reads flip to live via /api/*. Writes are live too (W4).
// Fixture fallback preserved for offline dev.

import { FEATURE_FLAGS } from "./flags";
import { data as F } from "./data";
import type {
  DiscoverFeedResult,
  EarningsSnapshot,
  EventRecord,
  Entity,
  SharedState,
  WatchlistRow,
  EtfDetail,
} from "./types";

const LIVE = true; // reads live; writes live (W4)

// Writes that hit persistence throw a typed error carrying the server's
// `fields` map for form-level validation UX.
export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function writeJson<T>(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  let json: unknown = null;
  try { json = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const err = json as { error?: string; message?: string; fields?: Record<string, string> } | null;
    throw new ApiError(
      r.status,
      err?.error ?? "http_error",
      err?.message ?? `${method} ${path} → ${r.status}`,
      err?.fields,
    );
  }
  return json as T;
}

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

  // Writes still fixture-only until W5.
  async refreshSources(_eventId: string): Promise<{ appended: number }> {
    if (FEATURE_FLAGS.liveMode) {
      throw new Error("Refresh-sources — W5 backend not yet wired");
    }
    return { appended: 0 };
  },

  async postFeedback(target: string, action: string, targetId?: string) {
    return writeJson<{ ok: true; id: string }>("/api/feedback", "POST", {
      target,
      targetId: targetId ?? target,
      action,
    });
  },

  async postEntity(entity: Partial<Entity>) {
    return writeJson<{ ok: true; ticker: string }>(
      "/api/entity-registry",
      "POST",
      entity,
    );
  },

  async putEntity(ticker: string, patch: Partial<Entity>) {
    return writeJson<{ ok: true; ticker: string }>(
      `/api/entity-registry/${encodeURIComponent(ticker)}`,
      "PUT",
      patch,
    );
  },

  async deleteEntity(ticker: string) {
    return writeJson<{ ok: true; ticker: string }>(
      `/api/entity-registry/${encodeURIComponent(ticker)}`,
      "DELETE",
    );
  },

  async postManualEntry(payload: {
    eventId: string;
    metricKey: string;
    slot?: "actual" | "estimate" | "prior";
    value: number;
    unit: string;
    sourceUrl: string;
    asOf: string;
    method: "bloomberg_manual" | "filing_manual" | "llm_extracted" | "yahoo" | "fmp";
    provenance?: "regulatory" | "ir-page" | "wire" | "news" | "social" | "independent";
    label?: string;
    locator?: string | null;
    confidence?: number;
    displayLabel?: string;
    isHeadline?: boolean;
  }) {
    return writeJson<{ ok: true; eventId: string; metricKey: string; slot: string }>(
      "/api/manual-entry",
      "POST",
      payload,
    );
  },

  async putSharedState(state: SharedState) {
    return writeJson<{ ok: true; lastCommit: string }>(
      "/api/shared-state",
      "PUT",
      state,
    );
  },

  async postDictionaryKey(entry: {
    key: string;
    label: string;
    unit: string;
    requiresIsAdjusted?: boolean;
    description?: string | null;
  }) {
    return writeJson<{ ok: true; key: string }>(
      "/api/metric-dictionary",
      "POST",
      entry,
    );
  },

  async discoverFeed(input: string): Promise<DiscoverFeedResult> {
    if (!LIVE) return F.discoverFeed(input);
    try {
      return await writeJson<DiscoverFeedResult>("/api/discover-feed", "POST", {
        url: input,
      });
    } catch (e) {
      if (typeof window === "undefined") return F.discoverFeed(input);
      throw e;
    }
  },
};
