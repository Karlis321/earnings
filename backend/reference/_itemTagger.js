// Thin server-side re-export wrapper around the canonical tagger at
// src/itemTagger.js. The canonical implementation is cross-runtime —
// it consumes data/entity-registry.json and data/source-stats.json via
// the `with { type: 'json' }` import attribute (stable in Node 22+,
// native in Vite/Rollup), so the same code path runs in both the
// Vercel API bundles and the Vite-bundled client.
//
// File is prefixed with `_` so Vercel does NOT expose it as an HTTP
// endpoint. Callers in api/ keep their existing relative-path
// imports unchanged.
export { tagItem, tagItems, ensureTagged, isTagged, ENTITY_INDEX_BY_TICKER } from '../src/itemTagger.js';
