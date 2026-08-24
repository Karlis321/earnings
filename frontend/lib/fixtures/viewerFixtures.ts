import type { SourceItem } from "@/lib/types";

// FIXTURE-ONLY — used by the /gallery page + the headless viewer
// audit (scripts/audits/viewer-source-check.mjs) to runtime-prove
// the SearchFallbackCard code path. This SourceItem exists solely
// so the audit can open the viewer with a URL matching
// google.com/search — the trigger for isSearchFallback in
// SourceViewer.tsx. Not in real corpus, not written to data/.
export const GOOGLE_SEARCH_FIXTURE_ITEM: SourceItem = {
  id: "fixture-google-search-1",
  url: "https://www.google.com/search?q=Capstone%20Copper%20Q2%202026%20earnings%20release",
  headline:
    "[FIXTURE] Google-search fallback item — used to prove the SearchFallbackCard viewer path",
  source: "Google Search",
  provenance: "wire",
  time: "2026-08-24T00:00:00.000Z",
  articleType: "news",
  engine: "google",
  language: "en",
  hosted: false,
  summary: null,
};
