// GitHub Contents API commit-pipe store.
// - Reads: pull deploy-baked JSON from the repo (cached in-memory 60s).
// - Writes: GET file SHA → PUT with new content + SHA → 409 retry.
// - Missing GH_PAT: return 503 shape so the API surface can respond cleanly.
//
// Write-ordering invariant (load-bearing):
//   Shard PUTs land BEFORE the events-index rebuild. Since readers
//   reconstitute events from index + shards, an index that references a
//   shard that hasn't been written yet would surface stale data. The
//   reverse (a shard newer than the index) is tolerated: readers walk
//   the shard list; a briefly-stale index entry just means the grid
//   summary lags for one cache cycle. `mutateEarnings` enforces this
//   with sequential awaits (all shard commits, then one index rebuild);
//   `writeShardForTicker` follows the same shard-then-index order.
//
// Atomicity gap (documented upgrade path):
//   Each shard PUT is its own git commit — so a cron interrupted after
//   12 of 20 shard writes leaves 12 fresh shards + a stale index (or a
//   half-refreshed index if `refreshIndexEntry` fired between shards).
//   The Git Trees API (POST /git/trees + /git/commits) can bundle all
//   changed shards + the rebuilt index into ONE atomic commit — that's
//   the future direction. Two wins: no partial-write window, and no
//   ~20-commits-per-cron history noise. Not a v1 blocker; the current
//   ordering invariant means any partial run only ever leaves a
//   *stale* index (readers still work) rather than a *dangling* one
//   (readers would reference a missing shard).

import type {
  CronRunSummary,
  Document,
  EarningsSnapshot,
  Entity,
  EventRecord,
  EventsIndex,
  EventsIndexEntry,
  FeedbackEntry,
  ReactionPoint,
  SourceItem,
  SharedState,
  MetricDictionary,
  EngineStatus,
} from "@/lib/types";
import type { Store } from "../store";
import { inMemoryStore } from "./inMemory";

const GH_API = "https://api.github.com";

interface GhConfig {
  pat: string;
  owner: string;
  repo: string;
  branch: string;
}

function config(): GhConfig | null {
  const pat = process.env.GH_PAT;
  const owner = process.env.GH_REPO_OWNER;
  const repo = process.env.GH_REPO_NAME;
  const branch = process.env.GH_BRANCH ?? "main";
  if (!pat || !owner || !repo) return null;
  return { pat, owner, repo, branch };
}

function headers(cfg: GhConfig) {
  return {
    Authorization: `Bearer ${cfg.pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "EarningsDashboard/1.0",
  };
}

interface FileState<T> {
  sha: string;
  content: T;
}

async function readFile<T>(
  cfg: GhConfig,
  path: string,
): Promise<FileState<T> | null> {
  const url =
    `${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}` +
    `?ref=${encodeURIComponent(cfg.branch)}`;
  const r = await fetch(url, { headers: headers(cfg), cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GH read ${path} → ${r.status}`);
  const j = (await r.json()) as {
    content?: string;
    sha: string;
    encoding?: string;
    size?: number;
    download_url?: string;
  };
  // GitHub's Contents API caps inline content at 1 MB. For larger files
  // it returns metadata with an empty `content` field and a
  // `download_url` we have to fetch separately. Since data/earnings.json
  // and data/entity-registry.json crossed 1 MB after universe expansion,
  // we always follow the download_url when content is empty.
  let raw: string;
  if (!j.content || j.content.length === 0) {
    if (!j.download_url) {
      throw new Error(`GH read ${path} → 200 but no content and no download_url (size=${j.size})`);
    }
    const rawResp = await fetch(j.download_url, {
      headers: {
        Authorization: `Bearer ${cfg.pat}`,
        "User-Agent": "EarningsDashboard/1.0",
      },
      cache: "no-store",
    });
    if (!rawResp.ok) {
      throw new Error(`GH raw ${path} → ${rawResp.status}`);
    }
    raw = await rawResp.text();
  } else {
    raw =
      j.encoding === "base64"
        ? Buffer.from(j.content, "base64").toString("utf8")
        : j.content;
  }
  return { sha: j.sha, content: JSON.parse(raw) as T };
}

// List entries in a directory via the Contents API. Returns null when
// the directory doesn't exist (404) — the summaries directory starts
// empty on a fresh repo and RSC callers should render nothing rather
// than blow up. Each entry carries a `name` (the basename) and a
// `type` ("file" | "dir"); the caller filters as needed.
interface GhDirEntry {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir" | "symlink" | "submodule";
}
async function listDir(
  cfg: GhConfig,
  path: string,
): Promise<GhDirEntry[] | null> {
  const url =
    `${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}` +
    `?ref=${encodeURIComponent(cfg.branch)}`;
  const r = await fetch(url, { headers: headers(cfg), cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GH listDir ${path} → ${r.status}`);
  const j = (await r.json()) as GhDirEntry[] | GhDirEntry;
  // Contents API returns an object when path is a file, an array when
  // path is a directory. Callers of this function always pass a dir.
  return Array.isArray(j) ? j : null;
}

async function writeFile<T>(
  cfg: GhConfig,
  path: string,
  content: T,
  message: string,
  priorSha: string | null,
): Promise<{ ok: true; sha: string } | { ok: false; conflict: true }> {
  const url =
    `${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2), "utf8").toString(
      "base64",
    ),
    branch: cfg.branch,
    ...(priorSha ? { sha: priorSha } : {}),
  };
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 409) return { ok: false as const, conflict: true as const };
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GH write ${path} → ${r.status} · ${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as { content: { sha: string } };
  return { ok: true, sha: j.content.sha };
}

// In-process read cache. GitHub's Contents API is the hot read path for
// RSC pages — a 60s TTL keeps per-request latency low without holding
// stale data long. Writes invalidate the entry immediately so the next
// read sees the new content, and RSC pages that render across a write
// boundary get the latest.
// Bumped from 60s to 5min so a slice-partitioned cron (which POSTs
// the same endpoint 5 times over ~8 min) doesn't re-read the full
// ~1,500-shard snapshot on every slice. Cache hit rate matters more
// than freshness here — the GitHub PAT rate limit (5k API req/hr)
// caps at exactly one full snapshot read per hour otherwise.
const READ_CACHE_MS = 300_000;
interface CacheEntry<T> {
  content: T;
  sha: string;
  expiresAt: number;
}
const readCache = new Map<string, CacheEntry<unknown>>();

function cacheKey(cfg: GhConfig, path: string): string {
  return `${cfg.owner}/${cfg.repo}@${cfg.branch}:${path}`;
}

async function readCached<T>(
  cfg: GhConfig,
  path: string,
): Promise<FileState<T> | null> {
  const key = cacheKey(cfg, path);
  const now = Date.now();
  const hit = readCache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) {
    return { sha: hit.sha, content: hit.content };
  }
  const fresh = await readFile<T>(cfg, path);
  if (fresh) {
    readCache.set(key, {
      content: fresh.content,
      sha: fresh.sha,
      expiresAt: now + READ_CACHE_MS,
    });
  } else {
    readCache.delete(key);
  }
  return fresh;
}

function invalidateCache(cfg: GhConfig, path: string) {
  readCache.delete(cacheKey(cfg, path));
}

// Commit-pipe write with 3-retry loop on 409.
async function commit<T>(
  cfg: GhConfig,
  path: string,
  mutate: (current: T | null) => T,
  message: string,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readFile<T>(cfg, path);
    const next = mutate(existing?.content ?? null);
    const result = await writeFile(
      cfg,
      path,
      next,
      message,
      existing?.sha ?? null,
    );
    if (result.ok) {
      // Prime the cache so the next read sees the just-written value
      // without another GitHub round-trip.
      readCache.set(cacheKey(cfg, path), {
        content: next,
        sha: result.sha,
        expiresAt: Date.now() + READ_CACHE_MS,
      });
      return next;
    }
    // 409 → refetch (bust cache) and retry with the new SHA.
    invalidateCache(cfg, path);
  }
  throw new Error(`GH commit ${path} failed after 3 attempts (409)`);
}

// File paths in the repo.
const P = {
  registry: "data/entity-registry.json",
  earnings: "data/earnings.json",
  eventsIndex: "data/events-index.json",
  eventsShard: (tickerSlug: string) => `data/events/${tickerSlug}.json`,
  sharedState: "data/shared-state.json",
  feedback: "data/feedback-log.json",
  dictionary: "data/metric-dictionary.json",
  cronStatus: "data/cron-status.json",
  pipelineReport: "data/pipeline-report.json",
  marketPulse: "data/market-pulse.json",
  ranking: "data/ranking.json",
  ideas: "data/ideas.json",
  // Stored as a JSON object `{schema, entries:[...]}` rather than raw
  // JSONL — the write path uses commit() which JSON.stringifies, and
  // append-then-commit reduces to updating one entry. The health page
  // consumes it programmatically so the exact file suffix is cosmetic.
  pipelineHistory: "data/pipeline-history.json",
  document: (id: string) => `data/documents/${id}.json`,
  summariesDir: "data/summaries",
  summary: (slug: string) => `data/summaries/${slug}.json`,
};

// "HBM US" → "HBM_US"; "AAPL34 BZ" → "AAPL34_BZ" — must match
// scripts/shard-earnings.mjs::tickerSlug.
function tickerSlug(ticker: string): string {
  return ticker.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

// Build a single index entry from a ticker's events + its registry row.
function buildIndexEntry(
  ticker: string,
  events: EventRecord[],
  entity: Entity | undefined,
): EventsIndexEntry {
  const past = events.filter((e) => e.eventDate);
  past.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  const future = events.filter((e) => !e.eventDate);
  future.sort((a, b) =>
    (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""),
  );
  const latest = past[0];
  const next = future[0];
  return {
    ticker,
    count: events.length,
    lastEventId: latest?.id ?? null,
    lastEventDate: latest?.eventDate ?? null,
    lastPeriod: latest?.period ?? null,
    lastSurprisePct:
      latest?.metrics?.find((m) => /eps/i.test(m.key ?? ""))?.surprisePct ??
      null,
    nextEventId: next?.id ?? null,
    nextScheduled: next?.scheduledDate ?? null,
    nextPeriod: next?.period ?? null,
    nextIsEstimated: !!next && next.freshness === "stale",
    nextCadence: next?.cadence,
    sourceCount: entity?.sourceCount ?? 0,
    guidanceMove: latest?.guidanceMove ?? null,
    freshness: latest?.freshness ?? "never",
  };
}

// Rebuild the entire events-index.json from a fresh EarningsSnapshot.
// Registry is read separately to preserve entity.sourceCount + include
// tickers with zero events.
async function rebuildAndWriteEventsIndex(
  cfg: GhConfig,
  snap: EarningsSnapshot,
) {
  const registryState = await readFile<{ entities: Entity[] } | Entity[]>(
    cfg,
    P.registry,
  );
  const entities = registryState
    ? Array.isArray(registryState.content)
      ? registryState.content
      : registryState.content.entities
    : [];
  const entityByTicker = new Map(entities.map((e) => [e.ticker, e]));
  const byTicker = new Map<string, EventRecord[]>();
  for (const ev of snap.events) {
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker)!.push(ev);
  }
  const entries: EventsIndexEntry[] = [];
  for (const [ticker, events] of byTicker) {
    entries.push(buildIndexEntry(ticker, events, entityByTicker.get(ticker)));
  }
  for (const e of entities) {
    if (byTicker.has(e.ticker)) continue;
    entries.push({
      ticker: e.ticker,
      count: 0,
      lastEventId: null,
      lastEventDate: null,
      lastPeriod: null,
      lastSurprisePct: null,
      nextEventId: null,
      nextScheduled: null,
      nextPeriod: null,
      nextIsEstimated: false,
      sourceCount: e.sourceCount ?? 0,
      guidanceMove: null,
      freshness: "never",
    });
  }
  await commit<EventsIndex>(
    cfg,
    P.eventsIndex,
    () => ({
      schema: "events-index/v1",
      updatedAt: new Date().toISOString(),
      entries,
    }),
    `store: events-index refresh`,
  );
}

// Patch a single entry in the events-index without rebuilding the whole
// thing. Used by single-shard writes (upsertEvent, appendEventSources,
// setReactionPoint, setVerdictNote). Fetches the entity once so
// sourceCount stays accurate.
async function refreshIndexEntry(
  cfg: GhConfig,
  ticker: string,
  events: EventRecord[],
) {
  const registryState = await readFile<{ entities: Entity[] } | Entity[]>(
    cfg,
    P.registry,
  );
  const entities = registryState
    ? Array.isArray(registryState.content)
      ? registryState.content
      : registryState.content.entities
    : [];
  const entity = entities.find((e) => e.ticker === ticker);
  const patched = buildIndexEntry(ticker, events, entity);
  await commit<EventsIndex>(
    cfg,
    P.eventsIndex,
    (cur) => {
      const base: EventsIndex = cur ?? {
        schema: "events-index/v1",
        updatedAt: new Date().toISOString(),
        entries: [],
      };
      const idx = base.entries.findIndex((e) => e.ticker === ticker);
      const entries = base.entries.slice();
      if (idx >= 0) entries[idx] = patched;
      else entries.push(patched);
      return { ...base, entries, updatedAt: new Date().toISOString() };
    },
    `index: refresh ${ticker}`,
  );
}

// Unwrap a shard file body — accepts both {schema, ticker, events} and
// the bare EventRecord[] shape (older shards may lack the wrapper).
function unwrapShard(content: unknown): EventRecord[] {
  if (Array.isArray(content)) return content as EventRecord[];
  const wrapped = content as { events?: EventRecord[] } | null;
  return wrapped?.events ?? [];
}

// Reconstitute a full EarningsSnapshot from the events-index + per-ticker
// shards. Bounded-concurrency parallel reads keep the cost tolerable even
// with ~1500 shards. The result is cached in-process for
// RECONSTITUTE_CACHE_MS so downstream RSC pages that call readEarnings
// multiple times per request only pay the fan-out once.
// Bumped 20 → 60. GitHub Contents API easily handles the burst
// (5k/hr = 83/sec average). Cuts cold-cache reconstitute from
// ~20-30s down to ~5-8s — critical for slice-0 of the sliced
// daily cron, which was hitting Vercel's 300s function timeout
// when reconstitute stacked on top of per-entity Yahoo work.
const SHARD_READ_CONCURRENCY = 60;
// Reconstituted-snapshot cache — same rationale as READ_CACHE_MS.
// A slice-partitioned cron does 5 sequential POSTs; without a
// multi-minute cache the reconstitution reruns every time and each
// rerun reads all ~1,500 shard files.
const RECONSTITUTE_CACHE_MS = 300_000;
interface ReconstituteCache {
  snapshot: EarningsSnapshot;
  expiresAt: number;
  cacheKey: string;
}
let reconstituteCache: ReconstituteCache | null = null;

function invalidateReconstitute() {
  reconstituteCache = null;
}

async function reconstituteFromShards(
  cfg: GhConfig,
): Promise<EarningsSnapshot | null> {
  const key = `${cfg.owner}/${cfg.repo}@${cfg.branch}`;
  const now = Date.now();
  if (
    reconstituteCache &&
    reconstituteCache.cacheKey === key &&
    reconstituteCache.expiresAt > now
  ) {
    return reconstituteCache.snapshot;
  }
  const indexState = await readFile<EventsIndex>(cfg, P.eventsIndex);
  if (!indexState) return null;
  const tickers = indexState.content.entries
    .filter((e) => e.count > 0)
    .map((e) => e.ticker);
  const shardEvents: EventRecord[][] = new Array(tickers.length);
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const idx = i++;
      const ticker = tickers[idx];
      try {
        const r = await readCached<unknown>(cfg, P.eventsShard(tickerSlug(ticker)));
        shardEvents[idx] = r ? unwrapShard(r.content) : [];
      } catch {
        shardEvents[idx] = [];
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(SHARD_READ_CONCURRENCY, tickers.length) },
      worker,
    ),
  );
  const snapshot: EarningsSnapshot = {
    schema: "earnings/v1",
    lastUpdated: indexState.content.updatedAt,
    events: shardEvents.flat(),
  };
  reconstituteCache = {
    snapshot,
    expiresAt: now + RECONSTITUTE_CACHE_MS,
    cacheKey: key,
  };
  return snapshot;
}

// Write a single ticker's shard + refresh its index entry. Two commits.
// Best-effort on the index (a shard write is authoritative; if the index
// falls behind briefly, it re-syncs on the next mutation).
async function writeShardForTicker(
  cfg: GhConfig,
  ticker: string,
  events: EventRecord[],
  message: string,
) {
  await commit<{ schema: string; ticker: string; events: EventRecord[] }>(
    cfg,
    P.eventsShard(tickerSlug(ticker)),
    () => ({ schema: "events-shard/v1", ticker, events }),
    message,
  );
  invalidateReconstitute();
  try {
    await refreshIndexEntry(cfg, ticker, events);
  } catch {
    /* index-entry refresh is best-effort */
  }
}

// Fallback to in-memory for reads that haven't been seeded to the repo yet.
async function readOrFallback<T>(
  cfg: GhConfig,
  path: string,
  fallback: () => Promise<T> | T,
): Promise<T> {
  try {
    const r = await readCached<T>(cfg, path);
    if (r) return r.content;
  } catch {
    /* fall through */
  }
  return fallback();
}

export function gitSnapshotStore(cfg: GhConfig): Store {
  return {
    async readRegistry(): Promise<Entity[]> {
      const r = await readOrFallback<{ entities: Entity[] } | Entity[]>(
        cfg,
        P.registry,
        () => inMemoryStore.readRegistry(),
      );
      return Array.isArray(r) ? r : r.entities;
    },
    async writeRegistry(entities: Entity[]) {
      await commit(
        cfg,
        P.registry,
        () => ({ schema: "entity-registry/v1", entities }),
        `store: registry update`,
      );
    },

    async readEarnings(): Promise<EarningsSnapshot> {
      // Shards are the source of truth. earnings.json remains in the repo
      // as a frozen archive but is no longer written to; skipping it here
      // avoids the 46 MB fetch on every RSC page render. If the index is
      // missing (fresh clone / local dev), fall back to the monolith so
      // legacy paths still return data.
      try {
        const reconstituted = await reconstituteFromShards(cfg);
        if (reconstituted) return reconstituted;
      } catch {
        /* fall through to monolith */
      }
      return readOrFallback(cfg, P.earnings, () =>
        inMemoryStore.readEarnings(),
      );
    },
    async readEventsIndex() {
      return readOrFallback<EventsIndex>(
        cfg,
        P.eventsIndex,
        async () => {
          // Fallback: compute from readEarnings() on the fly. Slower but
          // keeps callers working before the shard migration lands.
          const snap = await inMemoryStore.readEarnings();
          const byTicker = new Map<string, typeof snap.events>();
          for (const ev of snap.events) {
            if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
            byTicker.get(ev.ticker)!.push(ev);
          }
          const entries: EventsIndexEntry[] = [];
          for (const [ticker, events] of byTicker) {
            const past = events.filter((e) => e.eventDate);
            past.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
            const future = events.filter((e) => !e.eventDate);
            future.sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
            const latest = past[0];
            const next = future[0];
            entries.push({
              ticker,
              count: events.length,
              lastEventId: latest?.id ?? null,
              lastEventDate: latest?.eventDate ?? null,
              lastPeriod: latest?.period ?? null,
              lastSurprisePct:
                latest?.metrics?.find((m) => /eps/i.test(m.key ?? ""))?.surprisePct ?? null,
              nextEventId: next?.id ?? null,
              nextScheduled: next?.scheduledDate ?? null,
              nextPeriod: next?.period ?? null,
              nextIsEstimated: !!next && next.freshness === "stale",
              sourceCount: 0,
              guidanceMove: latest?.guidanceMove ?? null,
              freshness: latest?.freshness ?? "never",
            });
          }
          return {
            schema: "events-index/v1" as const,
            updatedAt: new Date().toISOString(),
            entries,
          };
        },
      );
    },
    async readEventsForTicker(ticker: string) {
      const r = await readOrFallback<unknown>(
        cfg,
        P.eventsShard(tickerSlug(ticker)),
        async () => {
          // Fallback: filter reconstituted snapshot by ticker.
          const snap = await this.readEarnings();
          return snap.events.filter((e) => e.ticker === ticker);
        },
      );
      return unwrapShard(r);
    },
    async upsertEvent(event: EventRecord) {
      // Shard-only write. Fetches the current shard, upserts by event.id,
      // writes the shard back, then patches this ticker's index entry.
      const existing = await readFile<unknown>(
        cfg,
        P.eventsShard(tickerSlug(event.ticker)),
      );
      const prior = existing ? unwrapShard(existing.content) : [];
      const idx = prior.findIndex((e) => e.id === event.id);
      const next = prior.slice();
      if (idx >= 0) next[idx] = event;
      else next.push(event);
      await writeShardForTicker(
        cfg,
        event.ticker,
        next,
        `shard: ${event.ticker} upsert ${event.id}`,
      );
    },
    async appendEventSources(
      eventId: string,
      items: SourceItem[],
      engineStatus: EngineStatus[],
    ) {
      // Find the event's ticker via the reconstituted snapshot (cached).
      const snap = await this.readEarnings();
      const target = snap.events.find((e) => e.id === eventId);
      if (!target) throw new Error(`no event ${eventId} to append to`);
      const ticker = target.ticker;
      // Read this ticker's shard and update the matching event.
      const existing = await readFile<unknown>(
        cfg,
        P.eventsShard(tickerSlug(ticker)),
      );
      if (!existing) throw new Error(`no shard for ${ticker}`);
      const prior = unwrapShard(existing.content);
      const next = prior.map((e) => {
        if (e.id !== eventId) return e;
        const seen = new Set(e.sources.items.map((i) => i.id));
        const newItems = items.filter((i) => !seen.has(i.id));
        return {
          ...e,
          sources: {
            ...e.sources,
            items: [...e.sources.items, ...newItems],
            engineStatus,
            capturedAt: new Date().toISOString(),
          },
        };
      });
      await writeShardForTicker(
        cfg,
        ticker,
        next,
        `shard: ${ticker} append sources to ${eventId} (${items.length} items)`,
      );
    },
    async setReactionPoint(eventId: string, point: ReactionPoint) {
      const snap = await this.readEarnings();
      const target = snap.events.find((e) => e.id === eventId);
      if (!target) throw new Error(`no event ${eventId}`);
      const ticker = target.ticker;
      const existing = await readFile<unknown>(
        cfg,
        P.eventsShard(tickerSlug(ticker)),
      );
      if (!existing) throw new Error(`no shard for ${ticker}`);
      const prior = unwrapShard(existing.content);
      const next = prior.map((e) => {
        if (e.id !== eventId) return e;
        const points = e.reaction.points.map((p) =>
          p.horizon === point.horizon ? point : p,
        );
        return { ...e, reaction: { ...e.reaction, points } };
      });
      await writeShardForTicker(
        cfg,
        ticker,
        next,
        `shard: ${ticker} reaction ${point.horizon} for ${eventId}`,
      );
    },
    async mutateEarnings(
      mutator: (snap: EarningsSnapshot) => EarningsSnapshot,
      message: string,
    ) {
      // Read the current snapshot (shard-reconstituted, cached in-process),
      // apply the mutator, then diff by ticker and write only the shards
      // whose events changed. Finally, rebuild the full events-index.
      // No monolith write.
      const current = await this.readEarnings();
      const next = {
        ...mutator(current),
        lastUpdated: new Date().toISOString(),
      };
      invalidateReconstitute();

      const groupBy = (events: EventRecord[]) => {
        const m = new Map<string, EventRecord[]>();
        for (const ev of events) {
          if (!m.has(ev.ticker)) m.set(ev.ticker, []);
          m.get(ev.ticker)!.push(ev);
        }
        return m;
      };
      const currentByTicker = groupBy(current.events);
      const nextByTicker = groupBy(next.events);

      const allTickers = new Set<string>([
        ...currentByTicker.keys(),
        ...nextByTicker.keys(),
      ]);
      const changedTickers: string[] = [];
      for (const ticker of allTickers) {
        const prev = currentByTicker.get(ticker) ?? [];
        const nxt = nextByTicker.get(ticker) ?? [];
        // Cheap length short-circuit, then structural compare.
        if (prev.length !== nxt.length) {
          changedTickers.push(ticker);
          continue;
        }
        if (JSON.stringify(prev) !== JSON.stringify(nxt)) {
          changedTickers.push(ticker);
        }
      }

      // Write each changed shard sequentially. GH commit-pipe serializes
      // per-file anyway, and this keeps rate-limit pressure predictable.
      for (const ticker of changedTickers) {
        const events = nextByTicker.get(ticker) ?? [];
        await commit<{
          schema: string;
          ticker: string;
          events: EventRecord[];
        }>(
          cfg,
          P.eventsShard(tickerSlug(ticker)),
          () => ({ schema: "events-shard/v1", ticker, events }),
          `${message} · shard ${ticker}`,
        );
      }

      // Full index rebuild so any lastPeriod/nextScheduled shifts land.
      try {
        await rebuildAndWriteEventsIndex(cfg, next);
      } catch {
        /* index refresh is best-effort — shards remain authoritative */
      }
    },
    async setVerdictNote(eventId: string, text: string) {
      const snap = await this.readEarnings();
      const target = snap.events.find((e) => e.id === eventId);
      if (!target) throw new Error(`no event ${eventId}`);
      const ticker = target.ticker;
      const existing = await readFile<unknown>(
        cfg,
        P.eventsShard(tickerSlug(ticker)),
      );
      if (!existing) throw new Error(`no shard for ${ticker}`);
      const prior = unwrapShard(existing.content);
      const next = prior.map((e) =>
        e.id === eventId
          ? {
              ...e,
              verdictNote: text
                ? { text, lastEditedAt: new Date().toISOString() }
                : undefined,
            }
          : e,
      );
      await writeShardForTicker(
        cfg,
        ticker,
        next,
        `shard: ${ticker} verdict for ${eventId}`,
      );
    },

    async readSharedState(): Promise<SharedState> {
      return readOrFallback(cfg, P.sharedState, () =>
        inMemoryStore.readSharedState(),
      );
    },
    async writeSharedState(state: SharedState) {
      await commit(cfg, P.sharedState, () => state, `store: shared-state`);
    },

    async readFeedback(): Promise<FeedbackEntry[]> {
      const r = await readOrFallback<
        { entries: FeedbackEntry[] } | FeedbackEntry[]
      >(cfg, P.feedback, () => inMemoryStore.readFeedback());
      return Array.isArray(r) ? r : r.entries;
    },
    async appendFeedback(entry: FeedbackEntry) {
      await commit<{ schema: string; entries: FeedbackEntry[] }>(
        cfg,
        P.feedback,
        (cur) => {
          const base = cur ?? { schema: "feedback/v1", entries: [] };
          return { ...base, entries: [...base.entries, entry] };
        },
        `store: feedback ${entry.action} ${entry.target}:${entry.targetId}`,
      );
    },

    async readDictionary(): Promise<MetricDictionary> {
      return readOrFallback(cfg, P.dictionary, () =>
        inMemoryStore.readDictionary(),
      );
    },
    async writeDictionary(dict: MetricDictionary) {
      await commit(cfg, P.dictionary, () => dict, `store: metric-dictionary`);
    },

    async readCronStatus(): Promise<CronRunSummary | null> {
      try {
        const r = await readCached<CronRunSummary>(cfg, P.cronStatus);
        return r?.content ?? null;
      } catch {
        return null;
      }
    },
    async writeCronStatus(status: CronRunSummary) {
      await commit(cfg, P.cronStatus, () => status, `cron: run @ ${status.finishedAt}`);
    },

    // Pipeline self-check artifacts.
    // pipeline-report.json is a single-object snapshot (overwrite per run).
    // pipeline-history.jsonl is append-only — one JSON object per line —
    // used by the health page's 30-day sparkline. Small enough that
    // fetch-append-commit stays fast even after years of history.
    async readPipelineReport() {
      try {
        const r = await readCached<import("../lib/pipelineReport").PipelineReport>(
          cfg,
          P.pipelineReport,
        );
        return r?.content ?? null;
      } catch {
        return null;
      }
    },
    async readMarketPulse() {
      try {
        const r = await readCached<unknown>(cfg, P.marketPulse);
        return r?.content ?? null;
      } catch {
        return null;
      }
    },
    async readRanking() {
      try {
        const r = await readCached<import("@/lib/types").Ranking>(
          cfg,
          P.ranking,
        );
        return r?.content ?? null;
      } catch {
        return null;
      }
    },
    async readIdeas() {
      try {
        const r = await readCached<import("@/lib/types").Ideas>(
          cfg,
          P.ideas,
        );
        return r?.content ?? null;
      } catch {
        return null;
      }
    },
    async writePipelineReport(report) {
      await commit(
        cfg,
        P.pipelineReport,
        () => report,
        `pipeline-report: ${report.date} · ${report.status}`,
      );
    },
    async readPipelineHistory() {
      try {
        const r = await readCached<{
          schema?: string;
          entries?: import("../lib/pipelineReport").PipelineHistoryEntry[];
        }>(cfg, P.pipelineHistory);
        return r?.content?.entries ?? [];
      } catch {
        return [];
      }
    },
    async appendPipelineHistory(entry) {
      // Append-then-commit. Same-day dedupe by date (idempotent on retry).
      await commit<{
        schema: string;
        entries: import("../lib/pipelineReport").PipelineHistoryEntry[];
      }>(
        cfg,
        P.pipelineHistory,
        (cur) => {
          const base = cur ?? { schema: "pipeline-history/v1", entries: [] };
          const entries = (base.entries ?? []).slice();
          const idx = entries.findIndex((e) => e.date === entry.date);
          if (idx >= 0) entries[idx] = entry;
          else entries.push(entry);
          return { schema: "pipeline-history/v1", entries };
        },
        `pipeline-history: ${entry.date} · ${entry.status}`,
      );
    },

    async readDocument(id: string): Promise<Document | null> {
      try {
        const r = await readCached<Document>(cfg, P.document(id));
        return r?.content ?? null;
      } catch {
        return null;
      }
    },

    async readSummariesForTicker(ticker: string) {
      // Resolve to canonical: a call with a non-canonical member ticker
      // (e.g. HBM CN vs the canonical HBM US) still finds the company's
      // summaries. Every summary file's `body.ticker` is the canonical
      // form, and filenames encode that same canonical.
      const entities = await this.readRegistry();
      const input = entities.find((e) => e.ticker === ticker);
      if (!input) return [];
      let canonical = input;
      if (input.isCanonical === false && input.companyId) {
        const canon = entities.find(
          (e) => e.companyId === input.companyId && e.isCanonical !== false,
        );
        if (canon) canonical = canon;
      }
      const slug = tickerSlug(canonical.ticker);
      const prefix = `${slug}_`;

      let dir: GhDirEntry[] | null;
      try {
        dir = await listDir(cfg, P.summariesDir);
      } catch {
        return [];
      }
      if (!dir) return [];
      const matches = dir.filter(
        (e) => e.type === "file" && e.name.endsWith(".json") && e.name.startsWith(prefix),
      );
      if (matches.length === 0) return [];

      const summaries: import("@/lib/types").Summary[] = [];
      for (const entry of matches) {
        try {
          const r = await readCached<import("@/lib/types").Summary>(
            cfg,
            entry.path,
          );
          if (r?.content) summaries.push(r.content);
        } catch {
          // Skip a single malformed summary rather than blow up the panel.
        }
      }
      // Sort by period desc via reported_at (both fields are populated
      // and validated; reported_at gives us date arithmetic for free).
      summaries.sort((a, b) => (b.reported_at ?? "").localeCompare(a.reported_at ?? ""));
      return summaries;
    },
    async writeDocument(doc: Document) {
      await commit(
        cfg,
        P.document(doc.meta.id),
        () => doc,
        `docs: ${doc.meta.id} v${doc.meta.ingestVersion} · ${doc.meta.title.slice(0, 60)}`,
      );
    },

    async snapshotAt(): Promise<string> {
      // Read the tiny events-index for its updatedAt stamp — same signal
      // as reading readEarnings().lastUpdated but one API call instead of
      // 1,416 shard reads. `/api/health` calls this on every request.
      try {
        const r = await readCached<EventsIndex>(cfg, P.eventsIndex);
        if (r?.content.updatedAt) return r.content.updatedAt;
      } catch {
        /* fall through */
      }
      return new Date().toISOString();
    },
    ghPatPresent(): boolean {
      return true;
    },
    mode(): "in-memory" | "git-snapshot" | "postgres" {
      return "git-snapshot";
    },
  };
}

export function tryGitSnapshot(): Store | null {
  const cfg = config();
  if (!cfg) return null;
  return gitSnapshotStore(cfg);
}
