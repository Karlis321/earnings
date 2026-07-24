// Feature flags. Sector view + LLM enrichment are OFF by default per FE PRD.
export const FEATURE_FLAGS = {
  sectors: true, // designed in P10 — visible but marked as flagged in nav
  llmEnrichment: false, // $0 mode
  commandPalette: true, // ⌘K optional per FE PRD §11
  liveMode: false, // P3 flips this to use real endpoints
};
