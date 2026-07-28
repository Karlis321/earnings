// Server-side pure helpers for entity + event lookups. Take the store
// arrays as inputs so RSC pages can pass in whatever `store.readRegistry()`
// / `store.readEarnings()` returned; the fixture path can pass its own
// arrays too. Keeps the same shape the fixture-file helpers used to expose
// without hard-linking to fixtures.

import type { EarningsSnapshot, Entity, EventRecord } from "@/lib/types";

export function findEntity(
  entities: Entity[],
  ticker: string,
): Entity | undefined {
  return entities.find((e) => e.ticker === ticker);
}

export function coreEntities(entities: Entity[]): Entity[] {
  return entities.filter((e) => e.isCore);
}

// Sector counts by canonical company — NVIDIA has 4 listings (BDR / MM
// / TB / CN) that all carry the same sectorTags. Previously each was
// counted separately and inflated tech-adjacent tags by +3 per multi-
// listed company. Now we count each company once by filtering to the
// canonical listing per companyId. Entities predating the Part-2 dedup
// (or singletons) all have isCanonical: true, so this stays correct
// even before the audit runs.
export function sectorCounts(
  entities: Entity[],
): Array<{
  id: string;
  count: number;
  portfolio: number;
  universe: number;
  equities: number;
  etfs: number;
}> {
  const canonicalOnly = entities.filter((e) => e.isCanonical !== false);
  const total = new Map<string, number>();
  const core = new Map<string, number>();
  const equities = new Map<string, number>();
  const etfs = new Map<string, number>();
  for (const e of canonicalOnly) {
    const isEtf = e.securityType === "etf";
    for (const s of e.sectorTags) {
      total.set(s, (total.get(s) ?? 0) + 1);
      if (e.isCore) core.set(s, (core.get(s) ?? 0) + 1);
      if (isEtf) etfs.set(s, (etfs.get(s) ?? 0) + 1);
      else equities.set(s, (equities.get(s) ?? 0) + 1);
    }
  }
  return Array.from(total, ([id, count]) => ({
    id,
    count,
    portfolio: core.get(id) ?? 0,
    universe: count - (core.get(id) ?? 0),
    equities: equities.get(id) ?? 0,
    etfs: etfs.get(id) ?? 0,
  })).sort((a, b) => b.count - a.count);
}

// Sector membership by canonical listing. A search for /sectors/technology
// returns one row per company, not one per listing — same reason as above.
export function entitiesInSector(
  entities: Entity[],
  sectorId: string,
): Entity[] {
  return entities.filter(
    (e) => e.isCanonical !== false && e.sectorTags.includes(sectorId),
  );
}

export function eventsForTicker(
  snap: EarningsSnapshot,
  ticker: string,
): EventRecord[] {
  return snap.events
    .filter((e) => e.ticker === ticker)
    .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));
}

export function latestEventFor(
  snap: EarningsSnapshot,
  ticker: string,
): EventRecord | undefined {
  return eventsForTicker(snap, ticker)[0];
}

export function findEvent(
  snap: EarningsSnapshot,
  eventId: string,
): EventRecord | undefined {
  return snap.events.find((e) => e.id === eventId);
}
