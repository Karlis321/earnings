// API client — reads flip to live via /api/*. Writes are live too (W4).
// Fixture fallback preserved for offline dev.

import { data as F } from "./data";
import type {
  DiscoverFeedResult,
  Document,
  EarningsSnapshot,
  EngineStatus,
  EventRecord,
  Entity,
  Provenance,
  SharedState,
  SourceItem,
  WatchlistRow,
  EtfDetail,
} from "./types";
import { mentionsHolding, matchesExclusionAlias } from "./tickerMatch";
import { dedupeItems, urlHash } from "./itemDedupe";

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

  // Refresh sources — parallel fan-out over news / press-releases / tweets,
  // filter to items that reference the entity (mentionsHolding), dedupe,
  // POST /events/:id/append-sources (idempotent — store also dedupes by id).
  async refreshSources(
    eventId: string,
  ): Promise<{ appended: number; engineStatus: EngineStatus[] }> {
    const event = await this.getEvent(eventId);
    if (!event) throw new ApiError(404, "not_found", `no event ${eventId}`);
    const entities = await this.getEntities();
    const entity = entities.find((e) => e.ticker === event.ticker);
    if (!entity) throw new ApiError(404, "not_found", `no entity ${event.ticker}`);

    const now = new Date().toISOString();

    interface PressReleaseResp {
      items?: Array<{
        headline: string;
        url: string;
        source: string;
        provenance: Provenance;
        time: string | null;
        kind: "edgar" | "rss";
      }>;
      engineStatus?: Array<{ label: string; kind: "edgar" | "rss"; ok: boolean; itemsFound: number }>;
    }
    interface NewsResp {
      items?: Array<{
        headline: string;
        url: string;
        source: string;
        category: string;
        time: string | null;
      }>;
    }
    interface TweetsResp {
      items?: Array<{
        id: string;
        headline: string;
        url: string;
        handle: string;
        time: string | null;
        engagement: { likes: number; reposts: number; replies: number };
      }>;
      engineStatus?: { engine: "twitter"; ok: boolean; itemsFound: number };
    }

    const [newsSettled, prSettled, twSettled] = await Promise.allSettled([
      fetch(`/api/news?q=${encodeURIComponent(entity.displayName)}&days=14`, {
        cache: "no-store",
      }).then((r) => r.json() as Promise<NewsResp>),
      fetch(`/api/press-releases?ticker=${encodeURIComponent(event.ticker)}`, {
        cache: "no-store",
      }).then((r) => r.json() as Promise<PressReleaseResp>),
      fetch(`/api/tweets?ticker=${encodeURIComponent(event.ticker)}`, {
        cache: "no-store",
      }).then((r) => r.json() as Promise<TweetsResp>),
    ]);

    const items: SourceItem[] = [];
    const engineStatus: EngineStatus[] = [];

    // ---- Press-releases (highest provenance — push first for dedup priority) ----
    if (prSettled.status === "fulfilled") {
      const pr = prSettled.value;
      let edgarN = 0, irRssN = 0, newsfileN = 0;
      for (const it of pr.items ?? []) {
        const isNewsfile = /Newsfile/i.test(it.source ?? "");
        const engine =
          it.kind === "edgar" ? "edgar" : isNewsfile ? "newsfile" : "ir-rss";
        if (engine === "edgar") edgarN++;
        else if (engine === "newsfile") newsfileN++;
        else irRssN++;
        items.push({
          id: urlHash(it.url),
          url: it.url,
          headline: it.headline,
          source: it.source,
          provenance: it.provenance,
          time: it.time ?? now,
          articleType: "news",
          engine,
          language: "en",
          hosted: false,
          summary: null,
        });
      }
      const statuses = pr.engineStatus ?? [];
      const hasEdgar = statuses.some((s) => s.kind === "edgar");
      const hasRss = statuses.some((s) => s.kind === "rss");
      if (hasEdgar) {
        engineStatus.push({
          engine: "edgar",
          ok: statuses.some((s) => s.kind === "edgar" && s.ok),
          itemsFound: edgarN,
        });
      }
      if (hasRss) {
        if (newsfileN > 0)
          engineStatus.push({ engine: "newsfile", ok: true, itemsFound: newsfileN });
        engineStatus.push({
          engine: "ir-rss",
          ok: statuses.some((s) => s.kind === "rss" && s.ok),
          itemsFound: irRssN,
        });
      }
    } else {
      engineStatus.push({ engine: "edgar", ok: false });
    }

    // ---- News (global feed; filter to items that mention the entity) ----
    if (newsSettled.status === "fulfilled") {
      const n = newsSettled.value;
      let newsN = 0;
      for (const it of n.items ?? []) {
        if (matchesExclusionAlias(it.headline, entity)) continue;
        if (!mentionsHolding(it.headline, entity)) continue;
        const provenance: Provenance =
          it.category === "wire" ? "wire" : "news";
        items.push({
          id: urlHash(it.url),
          url: it.url,
          headline: it.headline,
          source: it.source,
          provenance,
          time: it.time ?? now,
          articleType: "news",
          engine: "google",
          language: "en",
          hosted: false,
          summary: null,
        });
        newsN++;
      }
      engineStatus.push({ engine: "google", ok: true, itemsFound: newsN });
    } else {
      engineStatus.push({ engine: "google", ok: false });
    }

    // ---- Tweets ----
    if (twSettled.status === "fulfilled") {
      const t = twSettled.value;
      for (const it of t.items ?? []) {
        // Server-side vendor already applied mentionsHolding + exclusion.
        items.push({
          id: urlHash(it.url),
          url: it.url,
          headline: it.headline,
          source: it.handle ? `@${it.handle}` : "X",
          provenance: "social",
          time: it.time ?? now,
          articleType: "opinion",
          engine: "twitter",
          language: "en",
          hosted: false,
          summary: null,
          engagement: it.engagement,
        });
      }
      const es = t.engineStatus;
      engineStatus.push({
        engine: "twitter",
        ok: es?.ok ?? false,
        itemsFound: es?.itemsFound ?? 0,
      });
    } else {
      engineStatus.push({ engine: "twitter", ok: false });
    }

    const deduped = dedupeItems(items);
    const result = await writeJson<{ ok: true; appended: number }>(
      `/api/events/${encodeURIComponent(eventId)}/append-sources`,
      "POST",
      { items: deduped, engineStatus },
    );
    return { appended: result.appended, engineStatus };
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

  // Hosted-mode document fetch. Returns undefined when the URL hasn't been
  // ingested (404) — SourceViewer falls back to iframe / link-out.
  async getDocument(id: string): Promise<Document | undefined> {
    try {
      const r = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`document fetch ${r.status}`);
      return (await r.json()) as Document;
    } catch {
      return undefined;
    }
  },

  async ingestDocument(payload: {
    url: string;
    provenance?: "regulatory" | "ir-page" | "wire" | "news" | "social" | "independent";
    source?: string;
    language?: string;
    publishedAt?: string | null;
  }) {
    return writeJson<{
      ok: true;
      id: string;
      changed: boolean;
      ingestVersion: number;
      paragraphCount?: number;
      kind?: string;
      segments?: number;
    }>("/api/documents/ingest", "POST", payload);
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
