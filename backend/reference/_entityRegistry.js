// Server-side canonical entity registry loader.
//
// Mirror of src/entityRegistry.js exposing the same API surface but
// reading from disk on cold start (Vercel serverless functions). Both
// sides consume the same data/entity-registry.json file.
//
// File is prefixed with `_` so Vercel does NOT expose it as an HTTP
// endpoint.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read once at module load. The registry is a deploy-time artifact
// baked into the function bundle — it doesn't change between
// invocations, so caching at module scope is correct (Vercel keeps the
// function warm and reuses this).
function loadRegistry() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', 'data', 'entity-registry.json');
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    // Fail soft — return an empty registry so a corrupt JSON doesn't
    // bring down every endpoint. Downstream callers get empty lists.
    return { entities: [] };
  }
}

const REGISTRY = loadRegistry();
const ENTITIES = Array.isArray(REGISTRY?.entities) ? REGISTRY.entities : [];

const BY_TICKER = new Map();
for (const e of ENTITIES) {
  if (e && typeof e.ticker === 'string') BY_TICKER.set(e.ticker, e);
}

export function getAllEntities() {
  return ENTITIES;
}

export function getCoreEntities() {
  return ENTITIES.filter((e) => e.isCore === true);
}

export function getEntity(ticker) {
  return BY_TICKER.get(ticker) || null;
}

// Aliases include legalName + displayName + Bloomberg ticker so the
// substring matcher always sees the principal name forms + the
// parenthetical "BN US"-style ticker that frequently appears in
// article bodies.
export function getAliases(ticker) {
  const e = BY_TICKER.get(ticker);
  if (!e) return [];
  const out = new Set();
  if (e.legalName) out.add(e.legalName);
  if (e.displayName) out.add(e.displayName);
  if (e.ticker) out.add(e.ticker);
  for (const a of e.aliases || []) {
    if (a) out.add(a);
  }
  return Array.from(out);
}

export function getExclusionAliases(ticker) {
  const e = BY_TICKER.get(ticker);
  return e?.exclusionAliases ? [...e.exclusionAliases] : [];
}

export function getSectorTags(ticker) {
  const e = BY_TICKER.get(ticker);
  return e?.sectorTags ? [...e.sectorTags] : [];
}

export function getCashtag(ticker) {
  const e = BY_TICKER.get(ticker);
  return e?.cashtag || null;
}
