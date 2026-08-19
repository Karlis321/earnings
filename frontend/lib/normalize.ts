// Render-shape normalizers — the contract every page renders against.
//
// Store reads can return records with optional/nullable fields for
// historic reasons (legacy shard shape) OR because a recent pass
// created a minimal record (upcoming shell with no metrics; date-only
// past event from Stage 3 freshness backfill; entity from a
// deep-foreign name with no reaction bars). Components previously
// dereferenced these directly — `event.sources.items.filter(...)`
// would throw with 'Cannot read properties of undefined (reading
// filter)' when `sources` was null on a minimal shell.
//
// The normalizer here IS the contract. Every render path passes raw
// store data through it, so components see a fully-populated shape
// with empty arrays for every optional list and null (not undefined)
// for every optional scalar. Standing tests use this same set of
// canonical shapes as the fixture surface.

import type {
  EventRecord,
  Entity,
  Summary,
  MetricEntry,
  ReactionPoint,
  Horizon,
  Reaction,
  SourceItem,
  GuidanceEntry,
  CatalystDetail,
  EngineStatus,
  Freshness,
} from "./types";

const HORIZONS: Horizon[] = ["d1", "d3", "w1", "m1"];

function normalizeReactionPoints(raw: unknown): ReactionPoint[] {
  const arr = Array.isArray(raw) ? (raw as ReactionPoint[]) : [];
  // Guarantee every horizon has a slot even if the input skipped one
  // (a shell created before reaction maturation would have no points).
  const byHorizon = new Map<Horizon, ReactionPoint>();
  for (const p of arr) {
    if (p && HORIZONS.includes(p.horizon)) byHorizon.set(p.horizon, p);
  }
  return HORIZONS.map(
    (h) =>
      byHorizon.get(h) ?? {
        horizon: h,
        absReturn: null,
        excessReturn: null,
        benchmark: "",
        computedAt: null,
        status: "pending" as const,
      },
  );
}

function normalizeReaction(raw: unknown, entity: Entity | null): Reaction {
  const r = (raw ?? {}) as Partial<Reaction>;
  return {
    benchmark: r.benchmark ?? entity?.benchmark ?? "",
    baselineDate: r.baselineDate ?? null,
    baselineClose:
      typeof r.baselineClose === "number" ? r.baselineClose : null,
    points: normalizeReactionPoints(r.points),
  };
}

function normalizeSources(raw: unknown): EventRecord["sources"] {
  const s = (raw ?? {}) as Partial<EventRecord["sources"]>;
  return {
    windowStart: s.windowStart ?? "",
    windowEnd: s.windowEnd ?? "",
    capturedAt: s.capturedAt ?? null,
    items: Array.isArray(s.items) ? (s.items as SourceItem[]) : [],
    engineStatus: Array.isArray(s.engineStatus)
      ? (s.engineStatus as EngineStatus[])
      : [],
  };
}

function normalizeMetrics(raw: unknown): MetricEntry[] {
  return Array.isArray(raw) ? (raw as MetricEntry[]) : [];
}

function normalizeGuidance(raw: unknown): GuidanceEntry[] {
  return Array.isArray(raw) ? (raw as GuidanceEntry[]) : [];
}

function normalizeCatalysts(raw: unknown): CatalystDetail[] | undefined {
  return Array.isArray(raw) ? (raw as CatalystDetail[]) : undefined;
}

// Normalize one event. Passed by every page/component that renders
// events; components should NEVER see raw store shapes with missing
// arrays or null containers. The output type is EventRecord but with
// every optional list guaranteed non-null.
export function normalizeEvent(
  raw: EventRecord | undefined | null,
  entity: Entity | null = null,
): EventRecord {
  if (!raw) {
    // Callers should filter beforehand, but produce a safe empty
    // shape rather than crash. `id` empty signals "no event".
    return {
      id: "",
      ticker: "",
      kind: "earnings",
      period: "",
      scheduledDate: "",
      eventDate: null,
      timing: null,
      expectation: "unset",
      guidanceMove: null,
      freshness: "never" as Freshness,
      metrics: [],
      guidance: [],
      reaction: normalizeReaction(null, entity),
      sources: normalizeSources(null),
    };
  }
  return {
    ...raw,
    metrics: normalizeMetrics(raw.metrics),
    guidance: normalizeGuidance(raw.guidance),
    reaction: normalizeReaction(raw.reaction, entity),
    sources: normalizeSources(raw.sources),
    catalysts: normalizeCatalysts(raw.catalysts),
  } as EventRecord;
}

export function normalizeEvents(
  raw: (EventRecord | null | undefined)[] | undefined | null,
  entity: Entity | null = null,
): EventRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map((e) => normalizeEvent(e as EventRecord, entity));
}

// Normalize a summary (v1 shape had no `drivers` or `kpis`; v2 added
// drivers; v3 added callSnippets). Missing arrays become [] so the
// UI can `.map` without guarding.
export function normalizeSummary(raw: Summary | undefined | null): Summary | null {
  if (!raw) return null;
  return {
    ...raw,
    kpis: Array.isArray(raw.kpis) ? raw.kpis : [],
    drivers: Array.isArray(raw.drivers) ? raw.drivers : [],
    callSnippets: Array.isArray(raw.callSnippets) ? raw.callSnippets : [],
  } as Summary;
}

export function normalizeSummaries(raw: Summary[] | undefined | null): Summary[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => normalizeSummary(s)).filter((s): s is Summary => s != null);
}

// Entity normalizer — mostly a defensive re-shape for callers that
// want empty arrays instead of possibly-undefined optional fields.
export function normalizeEntity(raw: Entity | undefined | null): Entity | null {
  if (!raw) return null;
  return {
    ...raw,
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    exclusionAliases: Array.isArray(raw.exclusionAliases) ? raw.exclusionAliases : [],
    sectorTags: Array.isArray(raw.sectorTags) ? raw.sectorTags : [],
    headlineMetrics: Array.isArray(raw.headlineMetrics) ? raw.headlineMetrics : [],
    catalystTypes: Array.isArray(raw.catalystTypes) ? raw.catalystTypes : [],
  } as Entity;
}
