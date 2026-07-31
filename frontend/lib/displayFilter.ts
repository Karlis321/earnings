// Display filter — a display-only predicate that hides ETF and fund
// entities from every UI surface while leaving them fully intact in
// registry + shards. They still power benchmarks (reactionMaturation
// resolves benchmarks by SYMBOL, not through the registry, so hiding
// entity rows has no effect on excess-return computation), and any
// direct URL like /s/GDXJ%20US still loads. They just never appear
// in listings, search, sector aggregates, or the freshness denominator.
//
// True deletion — actually removing rows from data/entity-registry.json
// — is a separate deliberate task; not this one. See TODO_TOMORROW.md
// for the rationale ("keep benchmarks working" is the load-bearing
// reason to filter-not-delete).

import type { Entity } from "./types";

/**
 * True when the entity should appear on user-facing surfaces
 * (watchlist, sector views, cap-band groupings, global search).
 * False for ETFs, funds, and any future non-earnings-reporting type.
 *
 * A single predicate applied uniformly: the ONLY correct place to
 * introduce new "hide this type" logic is here.
 */
export function isDisplayable(entity: Pick<Entity, "securityType">): boolean {
  return entity.securityType === "operating" || entity.securityType === "developer";
}

/**
 * Filter a list of entities to displayable rows only. Same semantics
 * as isDisplayable applied via Array.filter — provided as a helper
 * so consumers don't re-invent the call pattern.
 */
export function displayableEntities<E extends Pick<Entity, "securityType">>(
  entities: E[],
): E[] {
  return entities.filter(isDisplayable);
}
