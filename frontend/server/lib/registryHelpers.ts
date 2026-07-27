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

export function sectorCounts(
  entities: Entity[],
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entities) {
    for (const s of e.sectorTags) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return Array.from(counts, ([id, count]) => ({ id, count })).sort(
    (a, b) => b.count - a.count,
  );
}

export function entitiesInSector(
  entities: Entity[],
  sectorId: string,
): Entity[] {
  return entities.filter((e) => e.sectorTags.includes(sectorId));
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
