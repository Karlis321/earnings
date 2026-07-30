import { LoadingSpinner } from "@/components/primitives/LoadingSpinner";

// Ticker page fetches registry + per-ticker shard + summaries — heavier
// than the overview, and the git-snapshot store can take ~1s cold. The
// spinner keeps the browser tab responsive during the wait instead of
// leaving the user staring at a stale previous page.
export default function TickerLoading() {
  return <LoadingSpinner label="Loading ticker…" size="lg" fullPage />;
}
