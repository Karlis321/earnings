// GitHub Contents API commit-pipe store.
// - Reads: pull deploy-baked JSON from the repo (cached in-memory 60s).
// - Writes: GET file SHA → PUT with new content + SHA → 409 retry.
// - Missing GH_PAT: return 503 shape so the API surface can respond cleanly.

import type {
  CronRunSummary,
  Document,
  EarningsSnapshot,
  Entity,
  EventRecord,
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
const READ_CACHE_MS = 60_000;
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
  sharedState: "data/shared-state.json",
  feedback: "data/feedback-log.json",
  dictionary: "data/metric-dictionary.json",
  cronStatus: "data/cron-status.json",
  document: (id: string) => `data/documents/${id}.json`,
};

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
      return readOrFallback(cfg, P.earnings, () =>
        inMemoryStore.readEarnings(),
      );
    },
    async upsertEvent(event: EventRecord) {
      await commit<EarningsSnapshot>(
        cfg,
        P.earnings,
        (cur) => {
          const base = cur ?? {
            schema: "earnings/v1" as const,
            lastUpdated: new Date().toISOString(),
            events: [],
          };
          const idx = base.events.findIndex((e) => e.id === event.id);
          const events = base.events.slice();
          if (idx >= 0) events[idx] = event;
          else events.push(event);
          return { ...base, events, lastUpdated: new Date().toISOString() };
        },
        `store: upsert event ${event.id}`,
      );
    },
    async appendEventSources(
      eventId: string,
      items: SourceItem[],
      engineStatus: EngineStatus[],
    ) {
      await commit<EarningsSnapshot>(
        cfg,
        P.earnings,
        (cur) => {
          if (!cur) throw new Error("no earnings snapshot to append to");
          const events = cur.events.map((e) => {
            if (e.id !== eventId) return e;
            // Dedup by item.id
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
          return { ...cur, events, lastUpdated: new Date().toISOString() };
        },
        `store: append sources to ${eventId} (${items.length} items)`,
      );
    },
    async setReactionPoint(eventId: string, point: ReactionPoint) {
      await commit<EarningsSnapshot>(
        cfg,
        P.earnings,
        (cur) => {
          if (!cur) throw new Error("no earnings snapshot");
          const events = cur.events.map((e) => {
            if (e.id !== eventId) return e;
            const points = e.reaction.points.map((p) =>
              p.horizon === point.horizon ? point : p,
            );
            return { ...e, reaction: { ...e.reaction, points } };
          });
          return { ...cur, events, lastUpdated: new Date().toISOString() };
        },
        `store: reaction ${point.horizon} for ${eventId}`,
      );
    },
    async mutateEarnings(
      mutator: (snap: EarningsSnapshot) => EarningsSnapshot,
      message: string,
    ) {
      await commit<EarningsSnapshot>(
        cfg,
        P.earnings,
        (cur) => {
          const base = cur ?? {
            schema: "earnings/v1" as const,
            lastUpdated: new Date().toISOString(),
            events: [],
          };
          const next = mutator(base);
          return { ...next, lastUpdated: new Date().toISOString() };
        },
        message,
      );
    },
    async setVerdictNote(eventId: string, text: string) {
      await commit<EarningsSnapshot>(
        cfg,
        P.earnings,
        (cur) => {
          if (!cur) throw new Error("no earnings snapshot");
          const events = cur.events.map((e) =>
            e.id === eventId
              ? {
                  ...e,
                  verdictNote: text
                    ? { text, lastEditedAt: new Date().toISOString() }
                    : undefined,
                }
              : e,
          );
          return { ...cur, events, lastUpdated: new Date().toISOString() };
        },
        `store: verdict for ${eventId}`,
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

    async readDocument(id: string): Promise<Document | null> {
      try {
        const r = await readCached<Document>(cfg, P.document(id));
        return r?.content ?? null;
      } catch {
        return null;
      }
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
      const snap = await this.readEarnings();
      return snap.lastUpdated;
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
